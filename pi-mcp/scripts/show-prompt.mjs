
import { loadConfig } from "../src/config.ts";
import { Sandbox } from "../src/sandbox.ts";
import { loadPiTools } from "../src/pi-tools.ts";
import { buildAgentPrompt } from "../src/prompt.ts";

const cfg = loadConfig([]);
const sandbox = new Sandbox(cfg.root, cfg.deny);
const pi = await loadPiTools(cfg.root, cfg.tools, sandbox);
console.log(buildAgentPrompt(cfg, pi.tools));
