#!/usr/bin/env node
/**
 * MCP stdio bridge: exposes G.A.R.T.H.'s Headquarters tools to Claude Code.
 *
 * Claude Code spawns this process (see --mcp-config in garth-cc.ts). It speaks newline-delimited
 * JSON-RPC 2.0 on stdin/stdout and forwards tool calls to HQ's HTTP API, so the tool list and
 * implementations live in one place (apps/hq/src/garth.ts). No dependencies on purpose.
 */
import readline from "node:readline";

const API = process.env.HQ_API ?? "http://127.0.0.1:4800";
const TOKEN = process.env.HQ_TOKEN ?? "dev-token";
const headers = { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, "x-hq-channel": process.env.HQ_CHANNEL ?? "" };

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...msg }) + "\n");
const reply = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize":
      return reply(id, {
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "headquarters", version: "0.1.0" },
        instructions: "Headquarters fleet control: outposts, tasks, files and shell on any device, operator notifications and decisions.",
      });
    case "ping":
      return reply(id, {});
    case "tools/list": {
      const r = await fetch(`${API}/api/garth/tools`, { headers });
      const tools = await r.json();
      return reply(id, { tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.input_schema })) });
    }
    case "tools/call": {
      try {
        const r = await fetch(`${API}/api/garth/tools/${encodeURIComponent(params.name)}`, {
          method: "POST",
          headers,
          body: JSON.stringify(params.arguments ?? {}),
        });
        const j = await r.json();
        if (!r.ok) return reply(id, { content: [{ type: "text", text: `error: ${j.error ?? r.statusText}` }], isError: true });
        const text = typeof j.result === "string" ? j.result : JSON.stringify(j.result, null, 1);
        return reply(id, { content: [{ type: "text", text }] });
      } catch (e) {
        return reply(id, { content: [{ type: "text", text: `error: Headquarters unreachable (${e.message})` }], isError: true });
      }
    }
    default:
      if (id !== undefined && id !== null) return fail(id, -32601, `method not found: ${method}`);
  }
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null, -32700, "parse error");
  }
  handle(msg).catch((e) => msg.id != null && fail(msg.id, -32603, e.message));
});
