/**
 * General stdio MCP server for Live selection (DL134).
 * Reads `.lq/live-selection.json` or `LQ_LIVE_SELECTION_PATH`.
 * Not a Cursor-only registerServer.
 */

import { invokeLiveSelection, MCP_TOOL_NAME, readLiveSelectionFile, resolveLiveSelectionPath } from "./liveSelection";

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_NAME = "lyx-preview";
const SERVER_VERSION = "0.1.0";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

const TOOL_DEF = {
  name: MCP_TOOL_NAME,
  description:
    "Return the current LyX Live Preview selection as JSON (file, selector, selected text). " +
    "Empty when the human has not selected in Live. The selector is a read reference, not a mutation selector.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

export async function handleJsonRpc(
  message: JsonRpcRequest,
  load: () => Promise<string>,
): Promise<JsonRpcResponse | undefined> {
  const id = message.id ?? null;
  const method = message.method;
  if (typeof method !== "string") {
    if (id === null) return undefined;
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } };
  }
  // Notifications have no id (or id is omitted). `initialized` is a notification.
  const isNotification = message.id === undefined && method.startsWith("notifications/");
  if (isNotification) return undefined;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }
  if (method === "notifications/initialized" || method === "initialized") {
    return undefined;
  }
  if (method === "ping") {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: [TOOL_DEF] } };
  }
  if (method === "tools/call") {
    const params = message.params;
    const name = params !== null && typeof params === "object"
      ? (params as { name?: unknown }).name
      : undefined;
    if (name !== MCP_TOOL_NAME) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `Unknown tool: ${String(name)}` },
      };
    }
    const text = await load();
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [{ type: "text", text }],
      },
    };
  }
  if (id === null) return undefined;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } };
}

export async function loadLiveSelectionText(opts?: {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}): Promise<string> {
  const path = resolveLiveSelectionPath({
    env: opts?.env ?? process.env,
    cwd: opts?.cwd ?? process.cwd(),
  });
  const record = await readLiveSelectionFile(path);
  return invokeLiveSelection(record);
}

function writeFramed(output: NodeJS.WritableStream, body: string): void {
  output.write(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n\r\n${body}`);
}

export function startMcpStdio(
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): void {
  let buffer = Buffer.alloc(0);
  input.on("data", (chunk: Buffer | string) => {
    buffer = Buffer.concat([buffer, typeof chunk === "string" ? Buffer.from(chunk) : chunk]);
    void drain();
  });

  async function drain(): Promise<void> {
    while (true) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = buffer.subarray(0, headerEnd).toString("utf8");
      const match = /Content-Length:\s*(\d+)/i.exec(header);
      if (!match) {
        buffer = buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number.parseInt(match[1] ?? "0", 10);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      const body = buffer.subarray(start, start + length).toString("utf8");
      buffer = buffer.subarray(start + length);
      let parsed: JsonRpcRequest;
      try {
        parsed = JSON.parse(body) as JsonRpcRequest;
      } catch {
        writeFramed(
          output,
          JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }),
        );
        continue;
      }
      const response = await handleJsonRpc(parsed, () => loadLiveSelectionText());
      if (response) writeFramed(output, JSON.stringify(response));
    }
  }
}

if (require.main === module) {
  startMcpStdio();
}
