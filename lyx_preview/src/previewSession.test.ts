import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AdapterError,
  LIVE_CONTRACT,
  PreviewSession,
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
      mapping: false,
      outline: false,
      editing: false,
      sourceReveal: false,
    },
    diagnostics: [],
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
      () => parseLiveStdout(validRender({ tokens: [] })),
      (e: unknown) => e instanceof AdapterError && e.code === "CONTRACT",
    );
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
