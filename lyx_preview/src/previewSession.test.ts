import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AdapterError,
  LIVE_CONTRACT,
  PreviewSession,
  emptyNavigate,
  formatChangeTime,
  parseLiveStdout,
} from "./previewSession";

function validRender(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    contract: LIVE_CONTRACT,
    projection: "live",
    html: "<article class=\"lyx-live\"></article>",
    source: {
      path: "C:/tmp/a.lyx",
      hashAlgorithm: "sha256",
      hashInput: "raw-file-bytes",
      diskHash: "a".repeat(64),
      lineEnding: "lf",
      lineCount: 2,
      fresh: true,
    },
    capabilities: {
      review: false,
      mapping: true,
      outline: true,
      editing: false,
      sourceReveal: false,
    },
    diagnostics: [],
    outline: [
      { level: 1, number: "1", text: "Intro", id: "sec-1" },
    ],
    navigate: emptyNavigate(),
    changes: [],
    tokens: [],
    ...over,
  });
}

describe("parseLiveStdout", () => {
  it("accepts a Live contract", () => {
    const render = parseLiveStdout(validRender());
    assert.equal(render.contract, LIVE_CONTRACT);
    assert.equal(render.projection, "live");
  });

  it("rejects malformed JSON", () => {
    assert.throws(() => parseLiveStdout("not-json"), (e: unknown) => e instanceof AdapterError && e.code === "MALFORMED_JSON");
  });

  it("classifies parse failures", () => {
    assert.throws(
      () => parseLiveStdout(JSON.stringify({ code: "PARSE_ERROR", message: "bad file" })),
      (e: unknown) => e instanceof AdapterError && e.code === "PARSE_ERROR",
    );
  });

  it("rejects deferred review/edit fields", () => {
    assert.throws(
      () => parseLiveStdout(validRender({ editTargets: [] })),
      (e: unknown) => e instanceof AdapterError && e.code === "CONTRACT",
    );
    assert.throws(
      () => parseLiveStdout(validRender({ reviewRegions: [] })),
      (e: unknown) => e instanceof AdapterError && e.code === "CONTRACT",
    );
  });

  it("accepts tokens and rejects unknown shapes", () => {
    const render = parseLiveStdout(validRender({
      tokens: [{ id: "tok-1", bundle: { selector: "layout[Standard]:nth-match(1)" } }],
    }));
    assert.equal(render.tokens.length, 1);
    assert.equal(render.capabilities.mapping, true);
    const leftover = parseLiveStdout(validRender({
      tokens: [{
        id: "cell-1",
        bundle: { selector: "layout[Standard]:nth-match(1)", coords: { row: 1, column: 2 } },
      }],
    }));
    assert.equal("coords" in leftover.tokens[0]!.bundle, false);
    assert.throws(
      () => parseLiveStdout(validRender({ tokens: [{ id: "tok-1", bundle: { selector: "" } }] })),
      (e: unknown) => e instanceof AdapterError && e.code === "CONTRACT",
    );
    assert.throws(
      () => parseLiveStdout(validRender({
        tokens: [
          { id: "tok-1", bundle: { selector: "layout[Standard]:nth-match(1)" } },
          { id: "tok-1", bundle: { selector: "layout[Standard]:nth-match(2)" } },
        ],
      })),
      (e: unknown) => e instanceof AdapterError && e.code === "CONTRACT",
    );
  });

  it("requires outline when capabilities.outline is true", () => {
    const raw = JSON.parse(validRender()) as Record<string, unknown>;
    delete raw.outline;
    assert.throws(
      () => parseLiveStdout(JSON.stringify(raw)),
      (e: unknown) => e instanceof AdapterError && e.code === "CONTRACT",
    );
  });

  it("accepts outline entries", () => {
    const render = parseLiveStdout(validRender({
      outline: [
        { level: 1, number: "1", text: "A", id: "sec-1" },
        { level: 2, number: "1.1", text: "B", id: "sec-1-1" },
      ],
    }));
    assert.equal(render.outline.length, 2);
    assert.equal(render.capabilities.outline, true);
  });

  it("accepts and validates the changes index", () => {
    const render = parseLiveStdout(validRender({
      changes: [
        { ordinal: 1, type: "inserted", author: "Alice", ts: "1724000000", anchorId: "change-1", snippet: "added" },
        { ordinal: 2, type: "deleted", author: "Bob", ts: "0", anchorId: "change-2", snippet: "removed" },
      ],
    }));
    assert.equal(render.changes.length, 2);
    assert.equal(render.changes[0]!.author, "Alice");
    assert.throws(
      () => parseLiveStdout(validRender({ changes: [{ ordinal: 1, type: "other" }] })),
      (e: unknown) => e instanceof AdapterError && e.code === "CONTRACT",
    );
  });
});

describe("formatChangeTime", () => {
  it("formats unix seconds as local YYYY-MM-DD HH:MM", () => {
    // 2024-08-18T12:33:20Z → local time; assert only the shape (timezone-dependent).
    assert.match(formatChangeTime("1723984400"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it("returns empty for zero, missing, and invalid timestamps", () => {
    assert.equal(formatChangeTime("0"), "");
    assert.equal(formatChangeTime(""), "");
    assert.equal(formatChangeTime("nope"), "");
  });
});

describe("PreviewSession generations", () => {
  it("discards obsolete overlapping results", () => {
    const session = new PreviewSession();
    const first = session.nextGeneration();
    const second = session.nextGeneration();
    const older = parseLiveStdout(validRender({ html: "<article>old</article>" }));
    const newer = parseLiveStdout(validRender({ html: "<article>new</article>" }));
    assert.equal(session.applySuccess(first, older), false);
    assert.equal(session.applySuccess(second, newer), true);
    assert.equal(session.lastValid?.html, "<article>new</article>");
  });

  it("keeps last valid render on failure and marks stale without changing generation", () => {
    const session = new PreviewSession();
    const gen = session.nextGeneration();
    const render = parseLiveStdout(validRender());
    assert.equal(session.applySuccess(gen, render), true);
    session.markStale();
    assert.equal(session.stale, true);
    assert.equal(session.lastValid?.html, render.html);
    const failed = session.nextGeneration();
    assert.equal(session.applyFailure(failed), true);
    assert.equal(session.lastValid?.html, render.html);
  });

  it("ignores a late failure from an older generation", () => {
    const session = new PreviewSession();
    const oldGen = session.nextGeneration();
    session.nextGeneration();
    assert.equal(session.applyFailure(oldGen), false);
  });
});
