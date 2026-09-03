import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  attachApproxLines,
  attachNavigateLines,
  buildNavigateRoots,
  dedupeNavigateLabels,
  nestOutlineEntries,
  scanLyxHeadingLines,
} from "./outlineNest";
import {
  forgetOutline,
  getCachedChanges,
  getCachedOutline,
  rememberOutline,
} from "./outlineProvider";


describe("nestOutlineEntries", () => {
  it("nests by level", () => {
    const roots = nestOutlineEntries([
      { level: 1, number: "1", text: "One", id: "sec-1" },
      { level: 2, number: "1.1", text: "Nested", id: "sec-1-1" },
      { level: 1, number: "2", text: "Two", id: "sec-2" },
    ]);
    assert.equal(roots.length, 2);
    assert.equal(roots[0]!.name, "1 One");
    assert.equal(roots[0]!.children.length, 1);
    assert.equal(roots[0]!.children[0]!.name, "1.1 Nested");
    assert.equal(roots[1]!.name, "2 Two");
  });
});

describe("scanLyxHeadingLines", () => {
  it("finds Section layouts and line numbers", () => {
    const lines = [
      "\\begin_body",
      "\\begin_layout Section",
      "First heading",
      "\\end_layout",
      "\\begin_layout Standard",
      "body",
      "\\end_layout",
      "\\begin_layout Subsection",
      "Child",
      "\\end_layout",
    ];
    const entries = scanLyxHeadingLines(lines);
    assert.equal(entries.length, 2);
    assert.equal(entries[0]!.text, "First heading");
    assert.equal(entries[0]!.level, 1);
    assert.equal(entries[0]!.line, 1);
    assert.equal(entries[1]!.text, "Child");
    assert.equal(entries[1]!.level, 2);
    assert.equal(entries[1]!.line, 7);
  });

  it("skips Argument short-title inset text", () => {
    const lines = [
      "\\begin_layout Section",
      "\\begin_inset Argument 1",
      "status collapsed",
      "\\begin_layout Plain Layout",
      "Short",
      "\\end_layout",
      "\\end_inset",
      "Long title here",
      "\\end_layout",
    ];
    const entries = scanLyxHeadingLines(lines);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.text, "Long title here");
  });
});

describe("attachApproxLines", () => {
  it("searches forward for entry text", () => {
    const lines = ["aa", "Body footnotes and notes", "bb", "Marginal and box"];
    const out = attachApproxLines(
      [
        { level: 1, number: "1", text: "Body footnotes and notes", id: "sec-1" },
        { level: 1, number: "2", text: "Marginal and box", id: "sec-2" },
      ],
      lines,
    );
    assert.equal(out[0]!.line, 1);
    assert.equal(out[1]!.line, 3);
  });
});

describe("dedupeNavigateLabels", () => {
  it("drops labels already covered by floats/equations, keeps outline-title leftovers", () => {
    const nav = dedupeNavigateLabels(
      {
        figures: [{ kind: "figure", number: "1", text: "A figure", id: "float-figure-1" }],
        tables: [],
        equations: [{ kind: "equation", number: "1", text: "x", id: "eq_a", name: "eq:a" }],
        labels: [
          // Same title as Outline must NOT drop a real leftover body label.
          { kind: "label", number: "", text: "", id: "note_hook", name: "note:custom-hook" },
          { kind: "label", number: "1", text: "A figure", id: "fig_a", name: "fig:a" },
          { kind: "label", number: "1", text: "", id: "eq_a", name: "eq:a" },
          { kind: "label", number: "", text: "", id: "orphan", name: "orphan" },
        ],
        listings: [],
        algorithms: [],
      },
    );
    assert.deepEqual(nav.labels.map((l) => l.name).sort(), ["note:custom-hook", "orphan"]);
  });
});

describe("attachNavigateLines", () => {
  it("locates floats by caption and labels by name", () => {
    const lines = [
      "\\begin_inset Float figure",
      "Inline figure caption.",
      "\\begin_inset Float table",
      "Block table caption",
      "\\begin_inset CommandInset label",
      'name "orphan-label"',
      "\\begin_inset Formula",
      "\\label{eq:demo}",
    ];
    const nav = attachNavigateLines(
      {
        figures: [{ kind: "figure", number: "1", text: "Inline figure caption.", id: "float-figure-1" }],
        tables: [{ kind: "table", number: "1", text: "Block table caption", id: "float-table-1" }],
        equations: [{ kind: "equation", number: "1", text: "x", id: "eq_demo", name: "eq:demo" }],
        labels: [{ kind: "label", number: "", text: "", id: "orphan-label", name: "orphan-label" }],
        listings: [],
        algorithms: [],
      },
      lines,
    );
    assert.equal(nav.figures[0]!.line, 1);
    assert.equal(nav.tables[0]!.line, 3);
    assert.equal(nav.equations[0]!.line, 7);
    assert.equal(nav.labels[0]!.line, 4);
  });
});

describe("buildNavigateRoots Changes", () => {
  const changes = [
    { ordinal: 1, type: "inserted" as const, author: "Alice", ts: "1724000000", anchorId: "change-1", snippet: "added" },
    { ordinal: 2, type: "deleted" as const, author: "Bob", ts: "0", anchorId: "change-2", snippet: "removed" },
  ];

  it("puts Changes right after Table of Contents with ordered rows", () => {
    const roots = buildNavigateRoots(
      [{ level: 1, number: "1", text: "Intro", id: "sec-1" }],
      { figures: [], tables: [], equations: [], labels: [], listings: [], algorithms: [] },
      changes,
    );
    assert.equal(roots[0]!.type, "group");
    assert.equal(roots[0]!.label, "Table of Contents");
    assert.equal(roots[1]!.type, "group");
    assert.equal(roots[1]!.label, "Changes");
    const rows = roots[1]!.type === "group" ? roots[1]!.children : [];
    assert.equal(rows.length, 2);
    assert.equal(rows[0]!.type, "change");
    assert.equal(rows[0]!.type === "change" ? rows[0]!.entry.anchorId : "", "change-1");
    assert.equal(rows[1]!.type === "change" ? rows[1]!.entry.anchorId : "", "change-2");
  });

  it("omits the group when there are no changes", () => {
    const roots = buildNavigateRoots(
      [{ level: 1, number: "1", text: "Intro", id: "sec-1" }],
      { figures: [], tables: [], equations: [], labels: [], listings: [], algorithms: [] },
      [],
    );
    assert(roots.every((r) => r.type !== "group" || r.key !== "changes"));
  });

  it("keeps subfloats as children of the parent figure (DL152)", () => {
    const roots = buildNavigateRoots([], {
      figures: [
        {
          kind: "figure",
          number: "1",
          text: "Outer",
          id: "float-figure-1",
          children: [
            { kind: "figure", number: "a", text: "Left", id: "float-figure-1-a" },
            { kind: "figure", number: "b", text: "Right", id: "float-figure-1-b" },
          ],
        },
        { kind: "figure", number: "2", text: "After", id: "float-figure-2" },
      ],
      tables: [],
      equations: [],
      labels: [],
      listings: [],
      algorithms: [],
    });
    const figGroup = roots.find((r) => r.type === "group" && r.key === "figures");
    assert.equal(figGroup?.type, "group");
    const items = figGroup?.type === "group" ? figGroup.children : [];
    assert.equal(items.length, 2);
    assert.equal(items[0]?.type, "item");
    const kids = items[0]?.type === "item" ? items[0].entry.children ?? [] : [];
    assert.deepEqual(kids.map((c) => `${c.number} ${c.text}`), ["a Left", "b Right"]);
    assert.equal(items[1]?.type === "item" ? items[1].entry.children?.length ?? 0 : -1, 0);
  });
});

describe("outline cache bounds", () => {
  it("keeps only the most recent paths", () => {
    for (let i = 0; i < 40; i++) {
      rememberOutline(`C:/tmp/doc-${i}.lyx`, [
        { level: 1, number: String(i), text: `Doc ${i}`, id: `sec-${i}` },
      ]);
    }
    assert.equal(getCachedOutline("C:/tmp/doc-0.lyx"), undefined);
    assert.equal(getCachedOutline("C:/tmp/doc-7.lyx"), undefined);
    assert.ok(getCachedOutline("C:/tmp/doc-8.lyx"));
    assert.ok(getCachedOutline("C:/tmp/doc-39.lyx"));
  });

  it("touching a path protects it from eviction", () => {
    for (let i = 0; i < 32; i++) {
      rememberOutline(`C:/tmp/touch-${i}.lyx`, [
        { level: 1, number: String(i), text: `Doc ${i}`, id: `sec-${i}` },
      ]);
    }
    getCachedOutline("C:/tmp/touch-0.lyx"); // LRU touch
    rememberOutline("C:/tmp/touch-new.lyx", [
      { level: 1, number: "x", text: "New", id: "sec-new" },
    ]);
    assert.ok(getCachedOutline("C:/tmp/touch-0.lyx"));
    assert.equal(getCachedOutline("C:/tmp/touch-1.lyx"), undefined);
  });

  it("forgetOutline removes a path and its case variants", () => {
    rememberOutline("C:/Docs/A.LYX", [
      { level: 1, number: "1", text: "A", id: "sec-a" },
    ]);
    forgetOutline("C:/Docs/A.LYX");
    assert.equal(getCachedOutline("C:/Docs/A.LYX"), undefined);
    // Case folding is Windows-only (sameFsPath); Linux paths are distinct.
    if (process.platform === "win32") {
      rememberOutline("C:/Docs/A.LYX", [
        { level: 1, number: "1", text: "A", id: "sec-a" },
      ]);
      forgetOutline("c:/docs/a.lyx");
      assert.equal(getCachedOutline("C:/Docs/A.LYX"), undefined);
    }
  });

  it("carries changes alongside outline/navigate", () => {
    rememberOutline("C:/tmp/changes.lyx", [
      { level: 1, number: "1", text: "A", id: "sec-a" },
    ], undefined, [
      { ordinal: 1, type: "inserted", author: "Alice", ts: "1724000000", anchorId: "change-1", snippet: "added" },
    ]);
    assert.equal(getCachedChanges("C:/tmp/changes.lyx")?.[0]?.anchorId, "change-1");
  });
});
