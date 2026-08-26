import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  LM_TOOL_NAME,
  LM_TOOL_REF,
  LiveSelectionStore,
  NO_LIVE_SELECTION,
  compactSelector,
  formatLiveSelectionJson,
  invokeLiveSelection,
  isObjectOnlyCommandInsetSelector,
  parseLiveSelectionJson,
  parseSelectMessage,
  readLiveSelectionFile,
  rematchSelection,
  resolveLiveSelectionPath,
  resolveSelection,
  writeLiveSelectionFile,
  type LiveSelectionRecord,
} from "./liveSelection";
import type { LiveToken } from "./previewSession";

const tokens: LiveToken[] = [
  { id: "tok-1", bundle: { selector: "layout[Standard]:nth-match(12)" } },
  {
    id: "tok-2",
    bundle: {
      selector: "inset[Tabular]:nth-match(1) inset[Text]:nth-match(2) layout[Plain Layout]",
    },
  },
  { id: "change-3", bundle: { selector: "layout[Standard]:nth-match(4)" } },
  { id: "tok-cite", bundle: { selector: "inset[CommandInset citation]:nth-match(1)" } },
  { id: "tok-href", bundle: { selector: "layout[Standard]:nth-match(1) inset[CommandInset href]:nth-match(2)" } },
];

const baseCtx = {
  file: "/tmp/doc.lyx",
  diskHash: "abc",
  stale: false,
  mode: "tracked" as const,
  capturedAt: "2026-08-24T12:00:00.000Z",
};

describe("parseSelectMessage", () => {
  it("parses caret vs highlight and multi", () => {
    assert.deepEqual(
      parseSelectMessage({ type: "select", id: "tok-1", selectedText: "", multi: false }),
      { id: "tok-1", selectedText: "", multi: false },
    );
    assert.deepEqual(
      parseSelectMessage({ type: "select", id: "tok-1", selectedText: "phrase", multi: true }),
      { id: "tok-1", selectedText: "phrase", multi: true },
    );
    assert.equal(parseSelectMessage({ type: "changeFocus", id: "change-1" }), undefined);
    assert.equal(parseSelectMessage({ type: "select", id: "" }), undefined);
  });
});

describe("resolveSelection / store", () => {
  it("builds a record from a token id", () => {
    const record = resolveSelection(tokens, "tok-1", "the phrase", false, baseCtx);
    assert.deepEqual(record, {
      file: "/tmp/doc.lyx",
      diskHash: "abc",
      stale: false,
      mode: "tracked",
      selector: "layout[Standard]:nth-match(12)",
      selectedText: "the phrase",
      changeId: null,
      multi: false,
      capturedAt: "2026-08-24T12:00:00.000Z",
    });
  });

  it("forces empty selectedText for cite/href CommandInset tokens (DL145 J2)", () => {
    assert.equal(isObjectOnlyCommandInsetSelector("inset[CommandInset citation]:nth-match(1)"), true);
    assert.equal(isObjectOnlyCommandInsetSelector("layout[Standard]:nth-match(12)"), false);
    const cite = resolveSelection(tokens, "tok-cite", "Abernethy et al. (2003)", false, baseCtx);
    assert.equal(cite?.selectedText, "");
    assert.equal(cite?.selector, "inset[CommandInset citation]:nth-match(1)");
    const href = resolveSelection(tokens, "tok-href", "lyx.org", false, baseCtx);
    assert.equal(href?.selectedText, "");
  });

  it("sets changeId for change owners and omits coords", () => {
    const cell = resolveSelection(tokens, "tok-2", "", false, baseCtx);
    assert.equal("coords" in (cell ?? {}), false);
    assert.equal(
      cell?.selector,
      "inset[Tabular]:nth-match(1) inset[Text]:nth-match(2) layout[Plain Layout]",
    );
    const change = resolveSelection(tokens, "change-3", "x", false, baseCtx);
    assert.equal(change?.changeId, "change-3");
    assert.equal(change?.selector, "layout[Standard]:nth-match(4)");
  });

  it("keeps the record when applySelect gets an unknown id", () => {
    const store = new LiveSelectionStore();
    store.applySelect(tokens, "tok-1", "hi", false, baseCtx);
    const kept = store.applySelect(tokens, "tok-missing", "nope", false, baseCtx);
    assert.equal(kept?.selector, "layout[Standard]:nth-match(12)");
    assert.equal(kept?.selectedText, "hi");
  });

  it("does not clear on blur (no select message)", () => {
    const store = new LiveSelectionStore();
    store.applySelect(tokens, "tok-1", "kept", false, baseCtx);
    assert.equal(store.get()?.selectedText, "kept");
  });

  it("marks stale when the buffer is dirty", () => {
    const store = new LiveSelectionStore();
    store.applySelect(tokens, "tok-1", "", false, baseCtx);
    store.markStale();
    assert.equal(store.get()?.stale, true);
  });

  it("resolves included-child tokens to child file + via (DL136)", () => {
    const foreign: LiveToken[] = [
      {
        id: "tok-9",
        bundle: {
          selector: "layout[Standard]:nth-match(1)",
          file: "/tmp/DummyDocument1.lyx",
          diskHash: "childhash",
          via: { file: "/tmp/doc.lyx", selector: "inset[CommandInset include]:nth-match(1)" },
        },
      },
    ];
    const record = resolveSelection(foreign, "tok-9", "dummy", false, {
      ...baseCtx,
      stale: true,
    });
    assert.equal(record?.file, "/tmp/DummyDocument1.lyx");
    assert.equal(record?.diskHash, "childhash");
    assert.equal(record?.stale, false);
    assert.deepEqual(record?.via, {
      file: "/tmp/doc.lyx",
      selector: "inset[CommandInset include]:nth-match(1)",
    });
  });

  it("markStale skips foreign child pointers (DL136 J3)", () => {
    const store = new LiveSelectionStore();
    store.set({
      file: "/tmp/DummyDocument1.lyx",
      diskHash: "childhash",
      stale: false,
      mode: "tracked",
      selector: "layout[Standard]:nth-match(1)",
      selectedText: "x",
      changeId: null,
      multi: false,
      capturedAt: "2026-08-24T12:00:00.000Z",
      via: { file: "/tmp/doc.lyx", selector: "inset[CommandInset include]:nth-match(1)" },
    });
    store.markStale("/tmp/doc.lyx");
    assert.equal(store.get()?.stale, false);
    store.markStale("/tmp/DummyDocument1.lyx");
    assert.equal(store.get()?.stale, true);
  });

  it("rematch keeps child file when preview master changes hash (DL136)", () => {
    const previous = resolveSelection(
      [{
        id: "tok-9",
        bundle: {
          selector: "layout[Standard]:nth-match(1)",
          file: "/tmp/DummyDocument1.lyx",
          diskHash: "childhash",
          via: { file: "/tmp/doc.lyx", selector: "inset[CommandInset include]:nth-match(1)" },
        },
      }],
      "tok-9",
      "hi",
      false,
      baseCtx,
    )!;
    const nextTokens: LiveToken[] = [
      {
        id: "tok-99",
        bundle: {
          selector: "layout[Standard]:nth-match(1)",
          file: "/tmp/DummyDocument1.lyx",
          diskHash: "childhash",
          via: { file: "/tmp/doc.lyx", selector: "inset[CommandInset include]:nth-match(1)" },
        },
      },
    ];
    const next = rematchSelection(previous, nextTokens, "/tmp/doc.lyx", "master-new", true);
    assert.equal(next.file, "/tmp/DummyDocument1.lyx");
    assert.equal(next.diskHash, "childhash");
    assert.equal(next.stale, false);
    assert.equal(next.via?.selector, "inset[CommandInset include]:nth-match(1)");
  });

  it("rematch after save updates diskHash and keeps selector", () => {
    const previous: LiveSelectionRecord = resolveSelection(tokens, "tok-1", "hi", false, baseCtx)!;
    const nextTokens: LiveToken[] = [
      { id: "tok-9", bundle: { selector: "layout[Standard]:nth-match(12)" } },
    ];
    const next = rematchSelection(previous, nextTokens, "/tmp/doc.lyx", "def", false);
    assert.equal(next.diskHash, "def");
    assert.equal(next.stale, false);
    assert.equal(next.selector, "layout[Standard]:nth-match(12)");
  });
});

describe("invoke / JSON / path", () => {
  it("returns no Live selection when empty", () => {
    assert.equal(invokeLiveSelection(undefined), NO_LIVE_SELECTION);
  });

  it("invoke returns the formatted record", () => {
    const record = resolveSelection(tokens, "tok-1", "the phrase", false, baseCtx)!;
    assert.equal(invokeLiveSelection(record), formatLiveSelectionJson(record));
    assert.match(invokeLiveSelection(record), /"selector": "layout\[Standard\]:nth-match\(12\)"/);
  });

  it("formats the record and round-trips the file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lyx-sel-"));
    try {
      const record = resolveSelection(tokens, "tok-2", "cell", false, baseCtx)!;
      const path = join(dir, ".lq", "live-selection.json");
      await writeLiveSelectionFile(path, record);
      const raw = readFileSync(path, "utf8");
      assert.equal(raw, formatLiveSelectionJson(record));
      const read = await readLiveSelectionFile(path);
      assert.deepEqual(read, record);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers workspace .lq/ then globalStorage", () => {
    assert.equal(
      resolveLiveSelectionPath({ workspaceFolder: "/ws" }),
      join("/ws", ".lq", "live-selection.json"),
    );
    assert.equal(
      resolveLiveSelectionPath({ globalStoragePath: "/g" }),
      join("/g", "live-selection.json"),
    );
  });

  it("compacts the selector for the status bar", () => {
    const record = resolveSelection(tokens, "tok-2", "", true, baseCtx)!;
    assert.equal(
      compactSelector(record),
      "inset[Tabular]:nth-match(1) inset[Text]:nth-match(2) layout[Plain Layout] +",
    );
  });

  it("ignores leftover coords in disk JSON (DL138 J3 override)", () => {
    const record = parseLiveSelectionJson(`{
      "file": "/tmp/doc.lyx",
      "diskHash": "abc",
      "stale": false,
      "mode": "tracked",
      "selector": "inset[Tabular]:nth-match(1)",
      "coords": { "row": 2, "column": 3 },
      "selectedText": "",
      "changeId": null,
      "multi": false,
      "capturedAt": "2026-08-24T12:00:00.000Z"
    }`)!;
    assert.equal("coords" in record, false);
    assert.equal(compactSelector(record), "inset[Tabular]:nth-match(1)");
    assert.equal(formatLiveSelectionJson(record).includes("coords"), false);
  });

  it("declares the LM tool in package.json", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
      contributes: { languageModelTools: Array<{ name: string; toolReferenceName: string }> };
    };
    const tool = pkg.contributes.languageModelTools.find((t) => t.name === LM_TOOL_NAME);
    assert.ok(tool);
    assert.equal(tool.toolReferenceName, LM_TOOL_REF);
  });
});
