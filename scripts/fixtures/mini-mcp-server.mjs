#!/usr/bin/env node
/**
 * The smallest possible MCP server: two tools over stdio, nothing else.
 *
 * It exists so the controls probe can attach a real upstream and exercise the
 * whole path - spawn, initialize, list, prefix, forward, disconnect - without
 * depending on any external server or the network.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "mini-mcp-fixture", version: "1.0.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "echo",
      description: "Echo the given text back, prefixed.",
      inputSchema: {
        type: "object",
        required: ["text"],
        properties: { text: { type: "string" } },
      },
    },
    {
      name: "path",
      description: "A tool whose name would collide with a reserved one when the upstream is called \"read\".",
      inputSchema: { type: "object", properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => ({
  content: [{ type: "text", text: `echo: ${String(req.params.arguments?.text ?? "")}` }],
}));

await server.connect(new StdioServerTransport());
