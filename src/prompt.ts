import type { AdaptedTool } from "./pi-tools.ts";
import type { Config } from "./config.ts";

/**
 * Pi's system prompt is a set of named sections rendered as
 * `<name>\n...\n</name>`, with the preamble kept raw (see
 * packages/coding-agent/src/core/system-prompt.ts). The rules list below is the
 * same algorithm Pi uses: per-tool guidelines in tool order, then global
 * guidelines, then its two closing rules.
 */
const PREAMBLE =
  "You are an expert coding assistant. You run on a remote machine, and your only way to " +
  "reach the user's computer is the tool set below, which is served by a small local bridge " +
  "(pi-mcp) running on that computer.";

const CLOSING_RULES = ["Be concise in your responses", "Show file paths clearly when working with files"];

const HUMAN_SECTION = [
  "The human who owns this computer is reachable ONLY through these tools:",
  "- human_say: report progress, results, or questions to the human. Returns immediately.",
  "- human_ask: ask the human a question and block until they answer.",
  "- human_wait: block until the human says anything at all.",
  "",
  "The client's own chat or question UI is NOT connected to this human. Never use a built-in",
  "question or approval tool (ask_user, ask_question, request_user_input, ask_human, elicit,",
  "request_permission, ...): it cannot reach them. Use human_ask / human_wait instead.",
  "",
  'human_ask and human_wait block for a bounded time and may return status="no_message" with',
  'the human having said nothing. That is not an error, not a timeout, and not a reason to',
  'stop: call human_wait again immediately and keep waiting.',
  "",
  "Do not end the conversation to signal that you are done. When a task is finished, report it",
  "with human_say(kind=\"done\"), then call human_wait for the human's next request.",
].join("\n");

/** Pi's buildRules(), reproduced. */
export function buildRules(tools: AdaptedTool[], promptGuidelines: string[] = []): string {
  const rules: string[] = [];
  const seen = new Set<string>();
  const add = (rule: string) => {
    const normalized = rule.trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    rules.push(normalized);
  };

  const names = new Set(tools.map((t) => t.name));
  const hasBash = names.has("bash");
  const hasPowerShell = names.has("powershell");
  const hasFileSearch = names.has("grep") || names.has("find") || names.has("ls");

  if ((hasBash || hasPowerShell) && !hasFileSearch) {
    if (hasBash && hasPowerShell) {
      add("Use bash or PowerShell for file operations like listing, searching, and finding files");
    } else if (hasPowerShell) {
      add("Use PowerShell for file operations like listing, searching, and finding files");
    } else {
      add("Use bash for file operations like ls, rg, find");
    }
  }
  for (const tool of tools) for (const rule of tool.guidelines) add(rule);
  for (const rule of promptGuidelines) add(rule);
  for (const rule of CLOSING_RULES) add(rule);

  return rules.map((rule) => `- ${rule}`).join("\n");
}

export function buildPromptSections(cfg: Config, tools: AdaptedTool[]): Record<string, string> {
  const visible = tools.filter((t) => t.snippet);
  const toolsBlock = visible.length
    ? visible.map((t) => `- ${t.name}: ${t.snippet}`).join("\n")
    : "(none)";

  return {
    preamble: PREAMBLE,
    tools: `${toolsBlock}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`,
    rules: buildRules(tools),
    human: HUMAN_SECTION,
    cwd: cfg.root.replace(/\\/g, "/"),
  };
}

/** Render exactly the way Pi renders its transcript system message. */
export function buildAgentPrompt(cfg: Config, tools: AdaptedTool[]): string {
  const sections = buildPromptSections(cfg, tools);
  const parts: string[] = [sections.preamble];
  for (const [name, content] of Object.entries(sections)) {
    if (name === "preamble") continue;
    parts.push(`<${name}>\n${content}\n</${name}>`);
  }
  return parts.join("\n\n");
}
