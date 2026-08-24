import assert from "node:assert/strict";
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
});
