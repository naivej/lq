import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  MCP_TOOL_NAME,
  NO_LIVE_SELECTION,
  writeLiveSelectionFile,
  type LiveSelectionRecord,
} from "./liveSelection";
import { handleJsonRpc, loadLiveSelectionText } from "./mcpServer";

const record: LiveSelectionRecord = {
  file: "/tmp/doc.lyx",
  diskHash: "abc",
  stale: false,
  mode: "tracked",
  selector: "layout[Standard]:nth-match(12)",
  coords: null,
  selectedText: "phrase",
  changeId: null,
  multi: false,
  capturedAt: "2026-08-24T12:00:00.000Z",
};

describe("MCP get_live_selection", () => {
  it("lists the tool and returns the JSON record", async () => {
    const listed = await handleJsonRpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }, async () => "");
    const tools = (listed?.result as { tools: Array<{ name: string }> }).tools;
    assert.equal(tools[0]?.name, MCP_TOOL_NAME);

    const called = await handleJsonRpc(
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: MCP_TOOL_NAME } },
      async () => JSON.stringify(record, null, 2),
    );
    const content = (called?.result as { content: Array<{ type: string; text: string }> }).content;
    assert.equal(content[0]?.type, "text");
    assert.match(content[0]?.text ?? "", /layout\[Standard\]:nth-match\(12\)/);
  });

  it("returns no Live selection when the file is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lyx-mcp-"));
    try {
      const text = await loadLiveSelectionText({
        env: { LQ_LIVE_SELECTION_PATH: join(dir, "missing.json") },
        cwd: dir,
      });
      assert.equal(text, NO_LIVE_SELECTION);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the same JSON the extension writes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lyx-mcp-"));
    try {
      const path = join(dir, "live-selection.json");
      await writeLiveSelectionFile(path, record);
      const text = await loadLiveSelectionText({
        env: { LQ_LIVE_SELECTION_PATH: path },
        cwd: dir,
      });
      assert.match(text, /"selector": "layout\[Standard\]:nth-match\(12\)"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("answers initialize without Cursor-only APIs", async () => {
    const init = await handleJsonRpc({ jsonrpc: "2.0", id: 0, method: "initialize" }, async () => "");
    const info = init?.result as { serverInfo: { name: string } };
    assert.equal(info.serverInfo.name, "lyx-preview");
  });

  it("stdio server returns the same JSON as invoke", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lyx-mcp-stdio-"));
    const path = join(dir, "live-selection.json");
    try {
      await writeLiveSelectionFile(path, record);
      const child = spawn(process.execPath, [join(__dirname, "mcpServer.js")], {
        env: { ...process.env, LQ_LIVE_SELECTION_PATH: path },
        stdio: ["pipe", "pipe", "pipe"],
      });
      try {
        sendFramed(child.stdin, { jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
        sendFramed(child.stdin, {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: MCP_TOOL_NAME },
        });
        const messages = await readFramed(child.stdout, 2, 3000);
        const call = messages.find((m) => m.id === 2);
        const text = (call?.result as { content: Array<{ text: string }> }).content[0]?.text ?? "";
        assert.match(text, /"selector": "layout\[Standard\]:nth-match\(12\)"/);
        assert.match(text, /"selectedText": "phrase"/);
      } finally {
        child.kill();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function sendFramed(stdin: NodeJS.WritableStream, obj: unknown): void {
  const body = JSON.stringify(obj);
  stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
}

function readFramed(
  stdout: NodeJS.ReadableStream,
  count: number,
  timeoutMs: number,
): Promise<Array<{ id?: unknown; result?: unknown }>> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const out: Array<{ id?: unknown; result?: unknown }> = [];
    const timer = setTimeout(() => reject(new Error("MCP stdio timed out")), timeoutMs);
    const onData = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const headerEnd = buf.indexOf("\r\n\r\n");
        if (headerEnd < 0) return;
        const match = /Content-Length:\s*(\d+)/i.exec(buf.subarray(0, headerEnd).toString("utf8"));
        if (!match) {
          buf = buf.subarray(headerEnd + 4);
          continue;
        }
        const length = Number.parseInt(match[1] ?? "0", 10);
        const start = headerEnd + 4;
        if (buf.length < start + length) return;
        out.push(JSON.parse(buf.subarray(start, start + length).toString("utf8")) as {
          id?: unknown;
          result?: unknown;
        });
        buf = buf.subarray(start + length);
        if (out.length >= count) {
          clearTimeout(timer);
          stdout.off("data", onData);
          resolve(out);
          return;
        }
      }
    };
    stdout.on("data", onData);
  });
}
