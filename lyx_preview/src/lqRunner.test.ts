import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runLivePreview, type SpawnFn } from "./lqRunner";
import { AdapterError, LIVE_CONTRACT, emptyNavigate } from "./previewSession";

const VALID_PAYLOAD = JSON.stringify({
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
  outline: [{ level: 1, number: "1", text: "Intro", id: "sec-1" }],
  navigate: emptyNavigate(),
  changes: [],
  tokens: [],
});

function isAdapterError(code: string): (err: unknown) => boolean {
  return (err) => err instanceof AdapterError && err.code === code;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "lq-runner-"));
}

/** Write a Node fake and return a spawn hook that runs it through this node. */
function writeFake(dir: string, name: string, js: string): SpawnFn {
  const script = join(dir, `${name}.js`);
  writeFileSync(script, js);
  return (_command, args, options) => spawn(process.execPath, [script, ...args], options);
}

describe("runLivePreview", () => {
  it("resolves a valid Live payload", async () => {
    const dir = tempDir();
    try {
      const lq = writeFake(dir, "ok", `process.stdout.write(${JSON.stringify(VALID_PAYLOAD)});\n`);
      const render = await runLivePreview("fake", "C:/tmp/a.lyx", 5000, undefined, undefined, undefined, lq);
      assert.equal(render.contract, LIVE_CONTRACT);
      assert.equal(render.outline[0]?.text, "Intro");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cancels the child when the signal aborts", async () => {
    const dir = tempDir();
    try {
      const lq = writeFake(dir, "slow", "setTimeout(function () { process.exit(0); }, 5000);\n");
      const ac = new AbortController();
      const promise = runLivePreview("fake", "C:/tmp/a.lyx", 30000, ac.signal, undefined, undefined, lq);
      setTimeout(() => ac.abort(), 100);
      await assert.rejects(promise, isAdapterError("CANCELLED"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects immediately for an already-aborted signal", async () => {
    const dir = tempDir();
    try {
      const lq = writeFake(dir, "slow", "setTimeout(function () { process.exit(0); }, 5000);\n");
      const ac = new AbortController();
      ac.abort();
      await assert.rejects(
        runLivePreview("fake", "C:/tmp/a.lyx", 30000, ac.signal, undefined, undefined, lq),
        isAdapterError("CANCELLED"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects with TIMEOUT when the child hangs", async () => {
    const dir = tempDir();
    try {
      const lq = writeFake(dir, "slow", "setTimeout(function () { process.exit(0); }, 5000);\n");
      await assert.rejects(
        runLivePreview("fake", "C:/tmp/a.lyx", 200, undefined, undefined, undefined, lq),
        isAdapterError("TIMEOUT"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects with OUTPUT_LIMIT when stdout overflows", async () => {
    const dir = tempDir();
    try {
      const lq = writeFake(
        dir,
        "noisy",
        "for (var i = 0; i < 200; i++) process.stdout.write('x'.repeat(100) + '\\n');\n",
      );
      await assert.rejects(
        runLivePreview("fake", "C:/tmp/a.lyx", 5000, undefined, 64, 64, lq),
        isAdapterError("OUTPUT_LIMIT"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects with OUTPUT_LIMIT when stderr overflows", async () => {
    const dir = tempDir();
    try {
      const lq = writeFake(
        dir,
        "noisy-stderr",
        "for (var i = 0; i < 200; i++) process.stderr.write('x'.repeat(100) + '\\n');\n",
      );
      await assert.rejects(
        runLivePreview("fake", "C:/tmp/a.lyx", 5000, undefined, 16 * 1024 * 1024, 64, lq),
        isAdapterError("OUTPUT_LIMIT"),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
