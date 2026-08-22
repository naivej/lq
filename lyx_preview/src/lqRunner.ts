import { spawn, type ChildProcess } from "node:child_process";
import { AdapterError, parseLiveStdout, type LiveRender } from "./previewSession";

export const DEFAULT_MAX_STDOUT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_STDERR_BYTES = 1024 * 1024;

/** Spawn hook used by tests to substitute a fake process (DL132 P1/P3). */
export type PreviewChild = ChildProcess & {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
};

export type SpawnFn = (
  command: string,
  args: string[],
  options: { windowsHide: boolean; stdio: ["ignore", "pipe", "pipe"] },
) => PreviewChild;

/**
 * Run `lq preview <file>` and resolve the parsed Live render (DL132 P1/P3).
 * An aborted signal kills the child; stdout/stderr are byte-capped so a
 * misbehaving process cannot exhaust extension-host memory.
 */
export function runLivePreview(
  lqPath: string,
  filePath: string,
  timeoutMs: number,
  signal?: AbortSignal,
  maxStdoutBytes = DEFAULT_MAX_STDOUT_BYTES,
  maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
  spawnFn: SpawnFn = spawn,
): Promise<LiveRender> {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let child;
    try {
      child = spawnFn(lqPath, ["preview", filePath], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      reject(new AdapterError("MISSING_BINARY", missingBinaryMessage(lqPath, error)));
      return;
    }

    const timer = setTimeout(() => {
      child.kill();
      finish(new AdapterError("TIMEOUT", `lq preview timed out after ${timeoutMs} ms.`));
    }, timeoutMs);

    const onAbort = (): void => {
      child.kill();
      finish(new AdapterError("CANCELLED", "Preview superseded or panel closed."));
    };

    function cleanup(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }

    function finish(error: Error): void {
      if (settled) return;
      settled = true;
      cleanup();
      const extra = stderr.trim();
      if (extra && !error.message.includes(extra.slice(0, 80))) {
        error.message = `${error.message} (${extra.slice(0, 200)})`;
      }
      reject(error);
    }

    if (signal) {
      if (signal.aborted) {
        child.kill();
        cleanup();
        reject(new AdapterError("CANCELLED", "Preview superseded or panel closed."));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (error: Error) => {
      finish(new AdapterError("MISSING_BINARY", missingBinaryMessage(lqPath, error)));
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, "utf8");
      if (stdoutBytes > maxStdoutBytes) {
        child.kill();
        finish(new AdapterError("OUTPUT_LIMIT", `lq preview stdout exceeded ${maxStdoutBytes} bytes.`));
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk, "utf8");
      if (stderrBytes > maxStderrBytes) {
        child.kill();
        finish(new AdapterError("OUTPUT_LIMIT", `lq preview stderr exceeded ${maxStderrBytes} bytes.`));
        return;
      }
      stderr += chunk;
    });
    child.on("close", () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        resolve(parseLiveStdout(stdout));
      } catch (error) {
        reject(error instanceof Error ? error : new AdapterError("PROCESS_ERROR", String(error)));
      }
    });
  });
}

function missingBinaryMessage(lqPath: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `Could not start lq at '${lqPath}'. Set lyx-preview.lqPath to the compiled lq binary. ${detail}`;
}
