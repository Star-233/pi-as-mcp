#!/usr/bin/env node
/**
 * An upstream whose tool list changes at runtime, for the tool-change probe.
 *
 * "grow" adds a tool named "later" and announces it with tools/list_changed.
 * The server advertises listChanged, so the bridge must rely on the
 * notification rather than polling.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

let grown = false;

const server = new Server(
  { name: "mutating-mcp-fixture", version: "1.0.0" },
  { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: "ping", description: "Reply pong.", inputSchema: { type: "object", properties: {} } },
    { name: "grow", description: "Add a tool named later and announce it.", inputSchema: { type: "object", properties: {} } },
    ...(grown
      ? [{
          name: "later",
          description: "Exists only after grow has run.",
          inputSchema: { type: "object", required: ["x"], properties: { x: { type: "string" } } },
        }]
      : []),
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name === "grow") {
    grown = true;
    await server.sendToolListChanged();
    return { content: [{ type: "text", text: "grown" }] };
  }
  if (req.params.name === "ping") return { content: [{ type: "text", text: "pong" }] };
  return { content: [{ type: "text", text: "later ok" }] };
});

await server.connect(new StdioServerTransport());
