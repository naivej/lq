import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { findLqInDir, resolveLqBinary } from "./lqResolve";
import { parseSha256Sums, ensureManagedLq, LqEnsureError, sha256File } from "./lqEnsure";
import { releaseAssetForPlatform, latestDownloadUrl } from "./lqPlatform";

describe("lqPlatform", () => {
  it("maps win/mac/linux x64 and arm64", () => {
    assert.equal(releaseAssetForPlatform("win32", "x64"), "lq_win64.exe");
    assert.equal(releaseAssetForPlatform("win32", "arm64"), "lq_win_arm64.exe");
    assert.equal(releaseAssetForPlatform("darwin", "x64"), "lq_mac64");
    assert.equal(releaseAssetForPlatform("darwin", "arm64"), "lq_mac_arm64");
    assert.equal(releaseAssetForPlatform("linux", "x64"), "lq_linux64");
    assert.equal(releaseAssetForPlatform("linux", "arm64"), "lq_linux_arm64");
    assert.equal(releaseAssetForPlatform("linux", "ia32"), undefined);
  });

  it("builds latest download URLs", () => {
    assert.equal(
      latestDownloadUrl("SHA256SUMS"),
      "https://github.com/naivej/lq/releases/latest/download/SHA256SUMS",
    );
  });
});

describe("lqResolve", () => {
  it("prefers newest lq* in dev dir over lqPath", () => {
    const dir = join(tmpdir(), `lq-resolve-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const older = join(dir, "lq_old");
      const newer = join(dir, "lq_new");
      writeFileSync(older, "a");
      // Ensure newer mtime
      writeFileSync(newer, "b");
      const found = findLqInDir(dir);
      assert.equal(found, newer);
      const r = resolveLqBinary("C:/managed/lq.exe", dir);
      assert.equal(r.kind, "dev");
      if (r.kind === "dev") assert.equal(r.path, newer);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers cargo lq.exe over other lq* names", () => {
    const dir = join(tmpdir(), `lq-resolve-cargo-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, "lq.d"), "dep");
      writeFileSync(join(dir, "lq_old"), "a");
      const exe = join(dir, "lq.exe");
      writeFileSync(exe, "bin");
      assert.equal(findLqInDir(dir), exe);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses managed lqPath when dev dir empty", () => {
    const dir = join(tmpdir(), `lq-resolve-empty-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const r = resolveLqBinary("/tmp/my-lq", dir);
      assert.deepEqual(r, { kind: "managed", path: "/tmp/my-lq" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns unset when no dev and empty lqPath", () => {
    const dir = join(tmpdir(), `lq-resolve-unset-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      assert.deepEqual(resolveLqBinary("", dir), { kind: "unset" });
      assert.deepEqual(resolveLqBinary(undefined, dir), { kind: "unset" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("lqEnsure", () => {
  it("parses SHA256SUMS", () => {
    const map = parseSha256Sums(
      "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899  lq_linux64\n" +
        "# comment\n" +
        "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff *lq_win64.exe\n",
    );
    assert.equal(
      map.get("lq_linux64"),
      "aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899",
    );
    assert.equal(
      map.get("lq_win64.exe"),
      "11223344556677889900aabbccddeeff11223344556677889900aabbccddeeff",
    );
  });

  it("downloads when missing and verifies hash", async () => {
    const payload = Buffer.from("fake-lq-binary-bytes");
    const hash = createHashHex(payload);
    const dir = join(tmpdir(), `lq-ensure-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const managed = join(dir, "lq");
    try {
      const fetchFn = async (url: string): Promise<Response> => {
        if (url.endsWith("SHA256SUMS")) {
          return new Response(`${hash}  lq_linux64\n`, { status: 200 });
        }
        if (url.endsWith("lq_linux64")) {
          return new Response(payload, { status: 200 });
        }
        return new Response("missing", { status: 404 });
      };
      const result = await ensureManagedLq(managed, {
        fetchFn,
        platform: "linux",
        arch: "x64",
      });
      assert.equal(result.updated, true);
      assert.equal(await sha256File(managed), hash);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips download when hash already matches", async () => {
    const payload = Buffer.from("already-there");
    const hash = createHashHex(payload);
    const dir = join(tmpdir(), `lq-ensure-skip-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const managed = join(dir, "lq");
    writeFileSync(managed, payload);
    let fetches = 0;
    try {
      const fetchFn = async (url: string): Promise<Response> => {
        fetches++;
        if (url.endsWith("SHA256SUMS")) {
          return new Response(`${hash}  lq_linux64\n`, { status: 200 });
        }
        throw new Error(`unexpected fetch ${url}`);
      };
      const result = await ensureManagedLq(managed, {
        fetchFn,
        platform: "linux",
        arch: "x64",
      });
      assert.equal(result.updated, false);
      assert.equal(fetches, 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects hash mismatch after download", async () => {
    const dir = join(tmpdir(), `lq-ensure-bad-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const managed = join(dir, "lq");
    try {
      const fetchFn = async (url: string): Promise<Response> => {
        if (url.endsWith("SHA256SUMS")) {
          return new Response(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  lq_linux64\n",
            { status: 200 },
          );
        }
        return new Response(Buffer.from("wrong-bytes"), { status: 200 });
      };
      await assert.rejects(
        () =>
          ensureManagedLq(managed, {
            fetchFn,
            platform: "linux",
            arch: "x64",
          }),
        (err: unknown) => err instanceof LqEnsureError && err.code === "HASH_MISMATCH",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function createHashHex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
