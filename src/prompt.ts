import type { AdaptedTool } from "./pi-tools.ts";
import type { Config } from "./config.ts";
import type { Skill } from "./skills.ts";

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
  "(pi-as-mcp) running on that computer.";

const CLOSING_RULES = ["Be concise in your responses", "Show file paths clearly when working with files"];

const HUMAN_SECTION = [
  "The human who owns this computer is reachable ONLY through these tools:",
  "- human_say: send them a message. Returns immediately.",
  "- human_ask: ask them a question and wait for the answer.",
  "- human_wait: wait for them to say anything.",
  "",
  "The chat UI of the client you are running in is NOT connected to this human. Built-in",
  "question and approval tools (ask_user, ask_question, request_user_input, ask_human, elicit,",
  "request_permission, ...) cannot reach them, even though they look like they can. Use",
  "human_ask and human_wait.",
  "",
  "A single reply can carry several of the human's messages. Whatever they typed while you were",
  "busy is queued, and the next human_ask or human_wait hands all of it over at once: oldest",
  "first, each line prefixed [n/total . HH:MM:SS], with the total in the result's \"count\". A",
  "single message arrives verbatim with no prefix. Read every line before you act - a later line",
  "often retracts an earlier one, and the stamps tell you how stale each line is, because the",
  "queue has no age limit.",
  "",
  "These tools return when their wait window closes. If the human has not spoken, the result is",
  'status="no_message". A no_message is not an error, not a timeout, not a failure, and not a',
  "sign that the human has gone away. It means only that the window closed.",
  "",
  "On no_message, call human_wait again - immediately, and again after the next one, for as long",
  "as the conversation lasts. Dozens of consecutive no_message results are normal: the human may",
  "be thinking, away from the keyboard, or asleep.",
  "",
  "Your turn must not end while you are waiting for the human. Do not end your turn, summarize,",
  "or sign off because the human is silent; do not decide you have waited long enough; do not",
  "pass a smaller max_block_ms to wait for less time. The only correct way to stop waiting is",
  "for the human to speak.",
  "",
  "If human_wait fails, is aborted, or your client reports a timeout or an error on the call,",
  "that is the same situation: call human_wait again immediately. A client-side timeout does",
  "not mean the human left.",
  "",
  'When a task is finished, report it with human_say(kind="done"), then call human_wait for the',
  "human's next request. Never finish by ending your turn.",
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

function xml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildPromptSections(
  cfg: Config,
  tools: AdaptedTool[],
  contextFiles: Array<{ path: string; content: string; truncated: boolean }> = [],
  skills: Array<Pick<Skill, "name" | "description" | "location">> = [],
): Record<string, string> {
  const visible = tools.filter((t) => t.snippet);
  const toolsBlock = visible.length
    ? visible.map((t) => `- ${t.name}: ${t.snippet}`).join("\n")
    : "(none)";

  const sections: Record<string, string> = {
    preamble: PREAMBLE,
    tools: `${toolsBlock}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project. Upstream MCP tools are prefixed with their server's name (for example github_list). That list can change while you work: if a tool you expect is missing, or a call reports an upstream as unavailable, call get_instructions for the current status.`,
    rules: cfg.approvalMode === "always"
      ? `${buildRules(tools)}\n- Every tool call is held for the human's approval before it runs. A denial is their answer to that call, not a failure: acknowledge it and wait for their guidance`
      : buildRules(tools),
    cwd: cfg.root.replace(/\\/g, "/"),
  };
  if (contextFiles.length) {
    sections.project_instructions = [
      "Instructions from project files (AGENTS.md or CLAUDE.md): the global file first, then from the git root down to the working root. Nearer files come later and take precedence. Follow them for work under this root.",
      ...contextFiles.map((f) => `## ${f.path.replace(/\\/g, "/")}${f.truncated ? " (truncated)" : ""}\n\n${f.content.trim()}`),
    ].join("\n\n");
  }
  if (skills.length) {
    sections.available_skills = [
      "Skills are instructions for particular kinds of task. When a task matches a skill's description, read its SKILL.md first, with the read tool and the path in its location. Files a skill mentions are under the same skill:// address, for example skill://<name>/scripts/run.sh. Skills are read-only.",
      ...skills.map((s) => `<skill>\n<name>${xml(s.name)}</name>\n<description>${xml(s.description)}</description>\n<location>${xml(s.location)}</location>\n</skill>`),
    ].join("\n\n");
  }
  // The <human> section is the entire instruction surface for the human channel.
  // With the channel off it must vanish, not shrink: a model told about tools it
  // cannot call will try to call them.
  if (cfg.human) sections.human = HUMAN_SECTION;
  return sections;
}

/** Render exactly the way Pi renders its transcript system message. */
export function buildAgentPrompt(
  cfg: Config,
  tools: AdaptedTool[],
  contextFiles: Array<{ path: string; content: string; truncated: boolean }> = [],
  skills: Array<Pick<Skill, "name" | "description" | "location">> = [],
): string {
  const sections = buildPromptSections(cfg, tools, contextFiles, skills);
  const parts: string[] = [sections.preamble];
  for (const [name, content] of Object.entries(sections)) {
    if (name === "preamble") continue;
    parts.push(`<${name}>\n${content}\n</${name}>`);
  }
  return parts.join("\n\n");
}