import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { latestDownloadUrl, releaseAssetForPlatform, type LqReleaseAsset } from "./lqPlatform";

export class LqEnsureError extends Error {
  constructor(
    message: string,
    readonly code:
      | "UNSUPPORTED_PLATFORM"
      | "NETWORK"
      | "HASH_MISMATCH"
      | "NOT_WRITABLE"
      | "MISSING_ASSET",
  ) {
    super(message);
    this.name = "LqEnsureError";
  }
}

export type FetchFn = (url: string) => Promise<Response>;

export type EnsureProgress = (message: string) => void;

export interface EnsureDeps {
  fetchFn?: FetchFn;
  platform?: NodeJS.Platform;
  arch?: string;
  onProgress?: EnsureProgress;
  /** When sums fetch fails and local file exists, keep local (default true). */
  allowOfflineFallback?: boolean;
}

/** Parse classic `SHA256SUMS` lines (`hash  name` or `hash *name`). */
export function parseSha256Sums(text: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = /^([0-9a-fA-F]{64})\s+\*?(\S+)\s*$/.exec(trimmed);
    if (!m) continue;
    map.set(m[2], m[1].toLowerCase());
  }
  return map;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function sha256Buffer(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function fetchOk(url: string, fetchFn: FetchFn): Promise<Response> {
  let res: Response;
  try {
    res = await fetchFn(url);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new LqEnsureError(`Network error fetching ${url}: ${detail}`, "NETWORK");
  }
  if (!res.ok) {
    throw new LqEnsureError(`HTTP ${res.status} fetching ${url}`, res.status === 404 ? "MISSING_ASSET" : "NETWORK");
  }
  return res;
}

/**
 * Ensure the managed binary at `managedPath` matches the latest GitHub Release
 * asset for this platform (DL155). No-op when hashes already match.
 */
export async function ensureManagedLq(
  managedPath: string,
  deps: EnsureDeps = {},
): Promise<{ updated: boolean; asset: LqReleaseAsset }> {
  const fetchFn = deps.fetchFn ?? fetch;
  const asset = releaseAssetForPlatform(deps.platform, deps.arch);
  if (!asset) {
    throw new LqEnsureError(
      `Unsupported platform (${deps.platform ?? process.platform}/${deps.arch ?? process.arch}). Set lyx-preview.lqPath to a binary you built.`,
      "UNSUPPORTED_PLATFORM",
    );
  }

  const sumsUrl = latestDownloadUrl("SHA256SUMS");
  const assetUrl = latestDownloadUrl(asset);

  let sumsText: string;
  try {
    deps.onProgress?.("Checking latest lq release…");
    const sumsRes = await fetchOk(sumsUrl, fetchFn);
    sumsText = await sumsRes.text();
  } catch (error) {
    if (deps.allowOfflineFallback !== false) {
      try {
        await sha256File(managedPath);
        deps.onProgress?.("Offline — using existing lq.");
        return { updated: false, asset };
      } catch {
        // missing local file
      }
    }
    throw error;
  }

  const sums = parseSha256Sums(sumsText);
  const expected = sums.get(asset);
  if (!expected) {
    throw new LqEnsureError(`SHA256SUMS has no entry for ${asset}`, "MISSING_ASSET");
  }

  try {
    const local = await sha256File(managedPath);
    if (local === expected) {
      return { updated: false, asset };
    }
  } catch {
    // missing — download
  }

  deps.onProgress?.("Updating lq…");
  const binRes = await fetchOk(assetUrl, fetchFn);
  const body = new Uint8Array(await binRes.arrayBuffer());
  const got = sha256Buffer(body);
  if (got !== expected) {
    throw new LqEnsureError(
      `Downloaded ${asset} hash mismatch (expected ${expected}, got ${got})`,
      "HASH_MISMATCH",
    );
  }

  const dir = dirname(managedPath);
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.lq-download-${process.pid}-${Date.now()}.tmp`);
  const aside = `${managedPath}.old`;

  try {
    await writeFile(tmp, body);
    try {
      await rm(aside, { force: true });
      await rename(managedPath, aside);
    } catch {
      // no existing file
    }
    try {
      await rename(tmp, managedPath);
    } catch (error) {
      // try restore aside
      try {
        await rename(aside, managedPath);
      } catch {
        // ignore
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new LqEnsureError(`Cannot write ${managedPath}: ${detail}`, "NOT_WRITABLE");
    }
    await rm(aside, { force: true }).catch(() => undefined);
    if (process.platform !== "win32") {
      await chmod(managedPath, 0o755);
    }
  } finally {
    await rm(tmp, { force: true }).catch(() => undefined);
  }

  const verify = await sha256File(managedPath);
  if (verify !== expected) {
    throw new LqEnsureError("Post-write hash mismatch", "HASH_MISMATCH");
  }

  deps.onProgress?.("lq ready");
  return { updated: true, asset };
}
