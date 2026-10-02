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
      "Ask the human a question and block until they answer. Returns status='human_message' with their reply, or status='no_message' if they did not answer in time (then call again). This is the ONLY way to get an answer from the human.",
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
      "Block until the human says anything. Use this instead of ending your turn. Returns status='human_message' with what they said, or status='no_message' if nothing arrived in time (then call it again immediately).",
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
      return { content: asJson(res) };
    }

    if (name === "human_wait") {
      const reason = typeof args.reason === "string" ? args.reason : undefined;
      const res = await withKeepAlive(extra, () =>
        channel.wait(reason, clampBlock(args.max_block_ms, cfg.blockMs)),
      );
      return { content: asJson(res) };
    }

    const tool = byName.get(name);
    if (!tool) {
      return { content: text(`Unknown tool: ${name}`), isError: true };
    }

    // Optional human approval gate for the dangerous verbs. Fails closed.
    if (cfg.approve.includes(name)) {
      const summary = describeCall(name, args);
      const verdict = await withKeepAlive(extra, () =>
        channel.ask(
          `Approve this ${name} call?\n\n${summary}\n\nReply "yes" to allow, anything else to deny.`,
          cfg.blockMs,
        ),
      );
      const approved =
        verdict.status === "human_message" && /^(y|yes|ok|okay|批准|可以|同意|好)/i.test(verdict.text.trim());
      if (!approved) {
        return {
          content: text(`Denied: the human did not approve this ${name} call.`),
          isError: true,
        };
      }
    }

    try {
      const result = await tool.call(args, signal);
      return { content: result.content, isError: result.isError };
    } catch (err) {
      return {
        content: text(err instanceof Error ? err.message : String(err)),
        isError: true,
      };
    }
  });

  return server;
}
