import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.ts";
import type { ApprovalMode } from "./config-file.ts";
import type { McpAggregator } from "./attach-mcp.ts";
import type { HumanChannel } from "./human/channel.ts";
import type { ApprovalGate } from "./approval.ts";
import type { AdaptedTool, ContentPart } from "./pi-tools.ts";
import { buildAgentPrompt } from "./prompt.ts";
import { describeCall } from "./sandbox.ts";
import { guardShell } from "./shell-guard.ts";
import type { ToolChangeTracker } from "./tool-watch.ts";
import { loadProjectContext } from "./context-files.ts";
import { discoverSkills } from "./skills.ts";

export const INSTRUCTIONS_TOOL = "get_instructions";

const text = (t: string): ContentPart[] => [{ type: "text", text: t }];
const asJson = (v: unknown): ContentPart[] => text(JSON.stringify(v, null, 2));

/**
 * A glance at what a tool returned, for the human-facing timeline. Deliberately
 * short: the full output already went to the agent, and the human only needs to
 * see whether it worked and roughly what came back.
 */
const PREVIEW_CHARS = 600;
function preview(parts: ContentPart[]): string | undefined {
  const body = parts
    .map((p: any) => (p?.type === "text" && typeof p.text === "string" ? p.text : ""))
    .join("\n")
    .trim();
  if (!body) return undefined;
  return body.length > PREVIEW_CHARS
    ? `${body.slice(0, PREVIEW_CHARS)}\n… (${body.length - PREVIEW_CHARS} more chars)`
    : body;
}

function toolSchema(name: string, description: string, inputSchema: unknown): any {
  return { name, description, inputSchema };
}

/** Human-channel tools. Deliberately three verbs and no notion of a session. */
function humanToolDefs(): any[] {
  return [
    toolSchema(
      "human_say",
      "Send a message to the human who owns this computer. Returns immediately; does not wait for a reply. Use it for progress, results, and anything the human should see now.",
      {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", description: "The message to show the human." },
          kind: {
            type: "string",
            enum: ["message", "progress", "done", "error", "note"],
            description: "Message category. Use 'done' for a finished task. Default: message.",
          },
        },
      },
    ),
    toolSchema(
      "human_ask",
      "Ask the human a question and block until they answer. This is the ONLY way to get an answer from the human. Returns status='human_message' with their reply, or status='no_message' if they had not replied when the wait window closed. Anything they typed while you were busy is queued and arrives with this result: several messages are merged oldest-first, each line prefixed [n/total . HH:MM:SS], and 'count' says how many. Read every line before acting - a later one may retract an earlier one. A no_message is not a failure: ask again, or switch to human_wait and keep waiting. Never end your turn while waiting for the human.",
      {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", description: "The question to ask." },
          max_block_ms: {
            type: "number",
            description: "How long to wait for an answer, in milliseconds. Default and maximum: server setting.",
          },
        },
      },
    ),
    toolSchema(
      "human_wait",
      "Block until the human says anything. Use this instead of ending your turn. Returns status='human_message' with everything they have said since your last call - one message arrives verbatim, several are merged oldest-first with a [n/total . HH:MM:SS] prefix on each line and 'count' set - or status='no_message' if nothing arrived before the wait window closed. Read every line before acting; a later one may retract an earlier one. A no_message is not an error and not a reason to stop: call human_wait again immediately and keep calling it for as long as the conversation lasts. Never end your turn while waiting for the human.",
      {
        type: "object",
        properties: {
          reason: { type: "string", description: "Optional short note shown to the human while you wait." },
          max_block_ms: {
            type: "number",
            description: "How long to wait, in milliseconds. Default and maximum: server setting.",
          },
        },
      },
    ),
  ];
}

/**
 * A no_message result is the most misread thing this server returns. Models see a quiet
 * JSON body, conclude the human is gone, and end their turn - dropping the human silently.
 * Lead with a plain sentence so it cannot be lost among the fields, and repeat it on every
 * occurrence rather than trusting the prompt to be remembered.
 */
function humanResult(res: { status: string }, again: string): { content: ContentPart[] } {
  if (res.status !== "no_message") return { content: asJson(res) };
  // One authoritative sentence, repeated in the payload, so the prose and the JSON cannot
  // disagree about which tool to call.
  const directive =
    `The human has said nothing yet. This is not a failure and not the end of anything: ` +
    `call ${again} again now, and keep calling it. Do not end your turn while waiting for ` +
    `the human.`;
  return {
    content: [
      { type: "text", text: directive },
      ...asJson({ ...res, hint: directive }),
    ],
  };
}

function clampBlock(requested: unknown, cap: number): number {
  const n = typeof requested === "number" && Number.isFinite(requested) ? requested : cap;
  return Math.max(1000, Math.min(n, cap));
}

/**
 * While a call is blocked on the human, emit periodic MCP progress
 * notifications. Many gateways (Cloudflare included) drop a request that has
 * been silent too long; this keeps the connection demonstrably alive.
 */
async function withKeepAlive<T>(extra: any, fn: () => Promise<T>): Promise<T> {
  const token = extra?._meta?.progressToken;
  if (token === undefined || typeof extra?.sendNotification !== "function") return fn();
  let tick = 0;
  const timer = setInterval(() => {
    tick += 1;
    try {
      Promise.resolve(
        extra.sendNotification({
          method: "notifications/progress",
          params: { progressToken: token, progress: tick, message: "waiting for the human" },
        }),
      ).catch(() => {});
    } catch {
      /* notifications are best effort */
    }
  }, 20000);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

export type RuntimeState = {
  human: boolean;
  approvalMode: ApprovalMode;
};

/**
 * The mutable half of the configuration: everything the config file (or the web
 * UI) can change while the bridge is up. The Server in HTTP mode is built fresh
 * for every request anyway, but stdio keeps one instance alive, so every
 * handler reads these fields at call time rather than capturing them once.
 */
export function createMcpServer(
  cfg: Config,
  piTools: AdaptedTool[],
  channel: HumanChannel,
  extras: {
    state: RuntimeState;
    /** The sandbox is the source of truth for the current root. */
    sandbox: { root: string };
    aggregator: McpAggregator | null;
    /** Remembers what the agent was last shown, so a change is announced once. */
    tracker: ToolChangeTracker;
    /** Where a held tool call waits for Allow or Deny on the web page. */
    approvals: ApprovalGate;
  },
): Server {
  // The prompt has to describe the bridge as it is *now* - the root moves at
  // runtime - so it is built through a view rather than captured once.
  const view = (): Config => ({
    ...cfg,
    root: extras.sandbox.root,
    human: extras.state.human,
    approvalMode: extras.state.approvalMode,
  });
  // Project instructions are read fresh for every build, so an edit shows up in
  // get_instructions straight away.
  const contextNow = () => loadProjectContext(view().root);
  // Skills are discovered fresh the same way, so a new or edited skill shows up at the next check.
  const skillsNow = () => discoverSkills(view().root);
  const buildInstructions = () => buildAgentPrompt(view(), piTools, contextNow(), skillsNow());
  const instructions = buildInstructions();
  const server = new Server(
    { name: cfg.serverName, version: "0.1.0" },
    { capabilities: { tools: {}, prompts: {} }, instructions },
  );

  const byName: Record<string, AdaptedTool> = {};
  for (const t of piTools) byName[t.name] = t;
  const humans = () => (extras.state.human ? humanToolDefs() : []);

  // Everything the agent can call right now, built fresh on every request. The
  // upstream part comes from the aggregator, so a connect, disconnect, or relist
  // shows up in the next tools/list.
  const currentTools = (): any[] => [
    ...piTools.map((t) => toolSchema(t.name, t.description, t.inputSchema)),
    ...humans(),
    ...(extras.aggregator?.tools() ?? []).map((t) => toolSchema(t.name, t.description, t.inputSchema)),
    toolSchema(
      INSTRUCTIONS_TOOL,
      "Return the operating instructions for this bridge verbatim, plus the live status of attached upstream MCP servers. Call once at the start of a session, and again when a tool you expect is missing or an upstream is reported unavailable.",
      { type: "object", properties: {} },
    ),
  ];

  // The agent is handed this list, so the tracker takes it as the baseline.
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = currentTools();
    extras.tracker.served(tools, contextNow(), skillsNow());
    return { tools };
  });

  // Live upstream status, appended to get_instructions.
  const upstreamStatus = (): string => {
    const ups = extras.aggregator?.summary() ?? [];
    if (ups.length === 0) return "Attached upstream MCP servers: none.";
    const lines = ups.map((u) => {
      const tools = u.tools.length ? ` (${u.tools.join(", ")})` : "";
      const err = u.error ? `; error: ${u.error}` : "";
      return `- ${u.name}: ${u.status}, ${u.toolCount} tool(s)${tools}${err}`;
    });
    return ["Attached upstream MCP servers (live):", ...lines].join("\n");
  };

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "pi_as_mcp_instructions",
        description: "The full operating instructions for this bridge (Pi's prompt plus the human channel rules).",
        arguments: [],
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    if (req.params.name !== "pi_as_mcp_instructions") {
      throw new Error(`Unknown prompt: ${req.params.name}`);
    }
    return {
      description: "Operating instructions for the pi-as-mcp bridge.",
      messages: [{ role: "user", content: { type: "text", text: buildInstructions() } }],
    };
  });

  // The call handler lives in dispatchCall; the wrapper after it adds the notice.
  const dispatchCall = async (req: any, extra: any): Promise<any> => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, any>;
    const signal: AbortSignal | undefined = extra?.signal;

    if (name === INSTRUCTIONS_TOOL) {
      return { content: text(`${buildInstructions()}\n\n${upstreamStatus()}`) };
    }

    if (name === "human_say" || name === "human_ask" || name === "human_wait") {
      if (!extras.state.human) {
        return {
          content: text(
            `Unknown tool: ${name}. The human channel is off (start with --human, or turn it on in the web UI or the config file).`,
          ),
          isError: true,
        };
      }
    }

    if (name === "human_say") {
      channel.say(String(args.text ?? ""), String(args.kind ?? "message"));
      return { content: asJson({ ok: true, delivered: true }) };
    }

    if (name === "human_ask") {
      const res = await withKeepAlive(extra, () =>
        channel.ask(String(args.text ?? ""), clampBlock(args.max_block_ms, cfg.blockMs)),
      );
      return humanResult(res, "human_ask");
    }

    if (name === "human_wait") {
      const reason = typeof args.reason === "string" ? args.reason : undefined;
      const res = await withKeepAlive(extra, () =>
        channel.wait(reason, clampBlock(args.max_block_ms, cfg.blockMs)),
      );
      return humanResult(res, "human_wait");
    }

    const proxied = extras.aggregator?.has(name) === true;
    const tool = byName[name];
    if (!tool && !proxied) {
      const hint = extras.aggregator?.unavailableHint(name);
      return { content: text(hint ?? `Unknown tool: ${name}`), isError: true };
    }

    // The shell guard: a hard stop for a short list of destructive shell lines.
    // It comes before the approval gate, so no approval mode and no answer from
    // the human lifts it. A refused call still shows on the page.
    const shellRefusal =
      name === "bash" || name === "powershell" ? guardShell(String(args.command ?? "")) : undefined;
    if (shellRefusal) {
      const message =
        `Blocked by the shell guard [${shellRefusal.rule}]: ${shellRefusal.reason}. ` +
        "This refusal applies in every approval mode. Reach the goal with a narrower, reversible command, or " +
        (extras.state.human ? "ask the human with human_ask." : "say so in your answer.");
      const callId = channel.toolStart(name, describeCall(name, args));
      channel.toolEnd(callId, false, 0, message);
      return { content: text(message), isError: true };
    }

    const summary = describeCall(name, args);

    // The approval gate, one setting for everything: "always" holds every tool
    // call - Pi's own and the proxied upstreams alike, because a proxied tool
    // can be as much of a shell as bash is. The hold is a card on the web page,
    // so it needs no human channel; with nobody at the page the call waits out
    // the window and is refused (fails closed).
    if (
      extras.state.approvalMode === "always" &&
      name !== INSTRUCTIONS_TOOL &&
      !name.startsWith("human_")
    ) {
      const approved = await withKeepAlive(extra, () =>
        extras.approvals.request(name, summary, 'approval mode is "always"', cfg.blockMs),
      );
      if (!approved) {
        return {
          content: text(`Denied: the human did not approve this ${name} call.`),
          isError: true,
        };
      }
    }

    // A proxied tool: forward it as-is. The sandbox does not apply - upstream
    // tools take no filesystem paths here - but the approval gate above and the
    // timeline below treat it exactly like a local one.
    if (proxied && extras.aggregator) {
      const callId = channel.toolStart(name, summary);
      const started = Date.now();
      const result = await extras.aggregator.call(name, args, signal);
      channel.toolEnd(callId, !result.isError, Date.now() - started, preview(result.content));
      return { content: result.content, isError: result.isError };
    }

    // The human sees every call this bridge runs on their machine, not just the
    // ones that speak through human_say. A tool call that errors still records.
    const callId = channel.toolStart(name, summary);
    const started = Date.now();

    try {
      const result = await tool.call(args, signal);
      channel.toolEnd(callId, !result.isError, Date.now() - started, preview(result.content));
      return { content: result.content, isError: result.isError };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      channel.toolEnd(callId, false, Date.now() - started, message);
      return {
        content: text(message),
        isError: true,
      };
    }
  };

  server.setRequestHandler(CallToolRequestSchema, async (req, extra: any) => {
    const result = await dispatchCall(req, extra);
    // The agent learns that the tool list moved through its next result, once.
    const notice = extras.tracker.takeNotice(currentTools(), contextNow(), skillsNow());
    if (!notice) return result;
    return { ...result, content: [...(result.content ?? []), { type: "text", text: notice }] };
  });

  return server;
}
