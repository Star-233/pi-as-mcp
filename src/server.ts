import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "./config.ts";
import type { HumanChannel } from "./human/channel.ts";
import type { AdaptedTool, ContentPart } from "./pi-tools.ts";
import { buildAgentPrompt } from "./prompt.ts";
import { describeCall } from "./sandbox.ts";

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

const APPROVAL_YES = /^(y|yes|ok|okay|批准|可以|同意|好)/i;
const QUEUE_PREFIX = /^\[\d+\/\d+ · \d{2}:\d{2}:\d{2}\]\s*/;

/**
 * Decide an approval from a human answer that may be several queued messages
 * merged into one string (see `delivery` in channel.ts).
 *
 * Every line has to be an approval. A retraction anywhere denies, and so does
 * anything unrecognised - the gate fails closed. Judging only the first line
 * would be worse than useless here: "yes" followed by "wait, no" would run the
 * command, which is exactly the case a retraction exists to prevent.
 *
 * Note that the merged form cannot be matched by the old one-shot regex: it
 * starts with "[1/2 · ", so the ^ anchor never fires and every multi-message
 * answer would deny. Stripping the prefixes is what makes merging compatible
 * with this gate at all.
 */
function approves(verdict: { status: string; text?: string }): boolean {
  if (verdict.status !== "human_message" || typeof verdict.text !== "string") return false;
  const lines = verdict.text
    .split("\n")
    .map((l) => l.replace(QUEUE_PREFIX, "").trim())
    .filter(Boolean);
  return lines.length > 0 && lines.every((l) => APPROVAL_YES.test(l));
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

export function createMcpServer(cfg: Config, piTools: AdaptedTool[], channel: HumanChannel): Server {
  const instructions = buildAgentPrompt(cfg, piTools);
  const server = new Server(
    { name: cfg.serverName, version: "0.1.0" },
    { capabilities: { tools: {}, prompts: {} }, instructions },
  );

  const byName = new Map<string, AdaptedTool>(piTools.map((t) => [t.name, t]));
  const humans = humanToolDefs();

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      ...piTools.map((t) => toolSchema(t.name, t.description, t.inputSchema)),
      ...humans,
      toolSchema(
        INSTRUCTIONS_TOOL,
        "Return the operating instructions for this bridge verbatim. Call once at the start of a session if your client did not already show them to you.",
        { type: "object", properties: {} },
      ),
    ],
  }));

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "pi_mcp_instructions",
        description: "The full operating instructions for this bridge (Pi's prompt plus the human channel rules).",
        arguments: [],
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (req) => {
    if (req.params.name !== "pi_mcp_instructions") {
      throw new Error(`Unknown prompt: ${req.params.name}`);
    }
    return {
      description: "Operating instructions for the pi-mcp bridge.",
      messages: [{ role: "user", content: { type: "text", text: instructions } }],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra: any) => {
    const name = req.params.name;
    const args = (req.params.arguments ?? {}) as Record<string, any>;
    const signal: AbortSignal | undefined = extra?.signal;

    if (name === INSTRUCTIONS_TOOL) return { content: text(instructions) };

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

    const tool = byName.get(name);
    if (!tool) {
      return { content: text(`Unknown tool: ${name}`), isError: true };
    }

    const summary = describeCall(name, args);

    // Optional human approval gate for the dangerous verbs. Fails closed.
    if (cfg.approve.includes(name)) {
      const verdict = await withKeepAlive(extra, () =>
        channel.ask(
          `Approve this ${name} call?\n\n${summary}\n\nReply "yes" to allow, anything else to deny.`,
          cfg.blockMs,
        ),
      );
      const approved = approves(verdict);
      if (!approved) {
        return {
          content: text(`Denied: the human did not approve this ${name} call.`),
          isError: true,
        };
      }
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
  });

  return server;
}
