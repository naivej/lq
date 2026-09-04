import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  UNSET_LQ_MESSAGE,
  expandUserPath,
  formatUnmanagedLqLoadedMessage,
  managedEnsureTarget,
  resolveLqBinary,
} from "./lqResolve";
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
  const sampleUnmanaged = "~/Github/lq_dev/lq/target/release/lq";
  const sampleRel = "Github/lq_dev/lq/target/release/lq";

  function withFakeHome(fn: (home: string) => void): void {
    const home = join(tmpdir(), `lq-home-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    mkdirSync(home, { recursive: true });
    try {
      fn(home);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("package.json default for unmanagedLqPath is empty", () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8")) as {
      version: string;
      contributes: { configuration: { properties: Record<string, { default?: string }> } };
    };
    assert.equal(pkg.version, "0.1.6");
    assert.equal(
      pkg.contributes.configuration.properties["lyx-preview.unmanagedLqPath"]?.default,
      "",
    );
  });

  it("unset copy names both path settings", () => {
    assert.match(UNSET_LQ_MESSAGE, /lyx-preview\.lqPath/);
    assert.match(UNSET_LQ_MESSAGE, /lyx-preview\.unmanagedLqPath/);
  });

  it("expands ~/ to home", () => {
    assert.equal(
      expandUserPath(sampleUnmanaged, "/home/u"),
      join("/home/u", sampleRel),
    );
    assert.equal(expandUserPath("~", "/home/u"), "/home/u");
    assert.equal(expandUserPath("/abs/lq", "/home/u"), "/abs/lq");
  });

  it("prefers unmanaged file over lqPath", () => {
    withFakeHome((home) => {
      const file = join(home, sampleRel);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "bin");
      const r = resolveLqBinary("C:/managed/lq.exe", sampleUnmanaged, { home });
      assert.equal(r.kind, "unmanaged");
      if (r.kind === "unmanaged") assert.equal(r.path, file);
    });
  });

  it("uses Windows .exe when unmanaged path has no suffix", () => {
    withFakeHome((home) => {
      const file = join(home, `${sampleRel}.exe`);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "bin");
      const r = resolveLqBinary("/managed", sampleUnmanaged, {
        home,
        platform: "win32",
      });
      assert.equal(r.kind, "unmanaged");
      if (r.kind === "unmanaged") assert.equal(r.path, file);
    });
  });

  it("does not add .exe on non-Windows", () => {
    withFakeHome((home) => {
      const file = join(home, `${sampleRel}.exe`);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "bin");
      const r = resolveLqBinary("/tmp/my-lq", sampleUnmanaged, {
        home,
        platform: "linux",
      });
      assert.deepEqual(r, { kind: "managed", path: "/tmp/my-lq" });
    });
  });

  it("skips empty unmanaged path", () => {
    withFakeHome((home) => {
      const file = join(home, sampleRel);
      mkdirSync(join(file, ".."), { recursive: true });
      writeFileSync(file, "bin");
      const r = resolveLqBinary("/tmp/my-lq", "", { home });
      assert.deepEqual(r, { kind: "managed", path: "/tmp/my-lq" });
    });
  });

  it("skips missing unmanaged file and uses lqPath", () => {
    withFakeHome((home) => {
      const r = resolveLqBinary("/tmp/my-lq", sampleUnmanaged, { home });
      assert.deepEqual(r, { kind: "managed", path: "/tmp/my-lq" });
    });
  });

  it("returns unset when unmanaged missing and lqPath empty", () => {
    withFakeHome((home) => {
      assert.deepEqual(resolveLqBinary("", sampleUnmanaged, { home }), { kind: "unset" });
      assert.deepEqual(resolveLqBinary(undefined, undefined, { home }), { kind: "unset" });
      assert.deepEqual(resolveLqBinary("", "", { home }), { kind: "unset" });
    });
  });

  it("managedEnsureTarget ignores spawn preference", () => {
    assert.equal(managedEnsureTarget("C:/managed/lq.exe"), "C:/managed/lq.exe");
    assert.equal(managedEnsureTarget("  /tmp/my-lq  "), "/tmp/my-lq");
    assert.equal(managedEnsureTarget(""), undefined);
    assert.equal(managedEnsureTarget(undefined), undefined);
  });

  it("formats unmanaged-loaded toast with ~/ and without .exe", () => {
    assert.equal(
      formatUnmanagedLqLoadedMessage(
        "C:\\Users\\Shifu\\Github\\lq_dev\\lq\\target\\release\\lq.exe",
        "C:\\Users\\Shifu",
      ),
      "Using local lq at ~/Github/lq_dev/lq/target/release/lq",
    );
    assert.equal(
      formatUnmanagedLqLoadedMessage("/home/u/Github/lq_dev/lq/target/release/lq", "/home/u"),
      "Using local lq at ~/Github/lq_dev/lq/target/release/lq",
    );
    assert.equal(
      formatUnmanagedLqLoadedMessage("/opt/lq/lq", "/home/u"),
      "Using local lq at /opt/lq/lq",
    );
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
        (err: unknown) =>
          err instanceof LqEnsureError &&
          err.code === "HASH_MISMATCH" &&
          /lyx-preview\.lqPath/.test(err.message) &&
          /unmanagedLqPath/.test(err.message),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects SHA256SUMS with no platform asset and names a next step", async () => {
    const dir = join(tmpdir(), `lq-ensure-sums-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    const managed = join(dir, "lq");
    try {
      const fetchFn = async (url: string): Promise<Response> => {
        if (url.endsWith("SHA256SUMS")) {
          return new Response(
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  other_asset\n",
            { status: 200 },
          );
        }
        throw new Error(`unexpected fetch ${url}`);
      };
      await assert.rejects(
        () =>
          ensureManagedLq(managed, {
            fetchFn,
            platform: "linux",
            arch: "x64",
          }),
        (err: unknown) =>
          err instanceof LqEnsureError &&
          err.code === "MISSING_ASSET" &&
          /SHA256SUMS/.test(err.message) &&
          /unmanagedLqPath/.test(err.message),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function createHashHex(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}
