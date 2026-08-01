/**
 * LyXServer client module.
 *
 * Communicates with a running LyX instance to send LFUN commands and
 * read responses. Supports two transport mechanisms:
 *
 *   Linux/macOS: Unix domain socket (ServerSocket.cpp)
 *     - Protocol: LYXCMD:<lfung> <args>
 *     - Response: INFO:<cmd>:<msg> or ERROR:<cmd>:<msg>
 *     - Discovery: $LYXSOCKET env var, or scan /tmp/lyx_tmpdir*
 *
 *   Windows: Named pipes (Server.cpp)
 *     - Protocol: LYXCMD:<client>:<lfung> <args>
 *     - Response: INFO:<client>:<lfung>:<msg> or ERROR:...
 *     - Discovery: default %APPDATA%\LyX2.5\lyxpipe
 *     - Pipe paths: \\.\pipe\<base>.in (write), \\.\pipe\<base>.out (read)
 */

import * as path from "@std/path";

/**
 * Race a promise against a timeout. The timer is cleared once the race settles
 * (either way) so it doesn't keep the process alive after the work completes
 * (test_report_34 Finding 8). Note (dev log 75): on Windows a pending
 * Deno.open/read on a named pipe cannot be cancelled at the OS level, so a
 * timed-out open may still be lingering — but the caller can degrade gracefully
 * because this promise rejects when the timeout wins.
 */
async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Pipe / socket discovery
// ---------------------------------------------------------------------------

/**
 * Discover the LyX pipe path on Windows.
 * Returns the base pipe path (without .in/.out suffix), or null if not found.
 */
function discoverWindowsPipePath(): string | null {
  // 1. Check LYXSOCKET environment variable
  const envSocket = Deno.env.get("LYXSOCKET");
  if (envSocket) return envSocket;

  // 2. Default location: %APPDATA%\LyX2.5\lyxpipe
  // Only return a path if LyX is actually running (check via tasklist).
  // Otherwise, Deno.open() on \\.\pipe\... blocks indefinitely waiting
  // for a pipe server that never comes.
  const appData = Deno.env.get("APPDATA");
  if (!appData) return null;

  const lyxDir = path.join(appData, "LyX2.5");
  try {
    Deno.statSync(lyxDir);
  } catch {
    return null;
  }

  // Quick check: is LyX running? If not, the pipe won't be listening.
  if (!isLyxRunning()) return null;

  return path.join(lyxDir, "lyxpipe");
}

/**
 * Check if a LyX process is running on Windows.
 * Uses tasklist.exe to avoid blocking on pipe CreateFile.
 */
function isLyxRunning(): boolean {
  try {
    const cmd = new Deno.Command("tasklist", {
      args: ["/fi", "IMAGENAME eq LyX.exe", "/nh"],
      stdout: "piped",
      stderr: "null",
    });
    const output = new TextDecoder().decode(cmd.outputSync().stdout);
    return output.includes("LyX.exe");
  } catch {
    return false;
  }
}

/**
 * Discover the LyX socket path on Unix.
 * Returns the socket path, or null if not found.
 */
function discoverUnixSocket(): string | null {
  // 1. Check LYXSOCKET environment variable
  const envSocket = Deno.env.get("LYXSOCKET");
  if (envSocket) return envSocket;

  // 2. Scan temp directories for lyxsocket files
  try {
    const tmpDir = Deno.env.get("TMPDIR") || "/tmp";
    for (const entry of Deno.readDirSync(tmpDir)) {
      if (entry.isDirectory && entry.name.startsWith("lyx_tmpdir")) {
        const socketPath = path.join(tmpDir, entry.name, "lyxsocket");
        try {
          const stat = Deno.statSync(socketPath);
          if (stat.isFile || stat.isSocket) return socketPath;
        } catch {
          // Socket doesn't exist in this temp dir
        }
      }
    }
  } catch {
    // Can't read temp dir
  }

  return null;
}

// ---------------------------------------------------------------------------
// Unix socket transport
// ---------------------------------------------------------------------------

async function sendViaUnixSocket(
  socketPath: string,
  lfuns: string[],
): Promise<{ sent: boolean; confirmed: boolean; errored: boolean }> {
  let conn: Deno.Conn | null = null;
  try {
    // Timeout: Deno.connect on a Unix socket hangs if the socket file exists
    // but no process accepts. Bounded via withTimeout (timer cleared on settle —
    // test_report_34 Finding 8; S1 dedup of the triplicated race pattern).
    conn = await withTimeout(Deno.connect({ path: socketPath, transport: "unix" }), 5000);
  } catch {
    return { sent: false, confirmed: false, errored: false };
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const buf = new Uint8Array(4096);

  let sent = false;
  let confirmed = false;
  let errored = false;

  async function readLine(): Promise<string | null> {
    let data = "";
    while (true) {
      // 5-second timeout per read — protects against a hung server
      // (bounded via withTimeout; timer cleared on settle). The .catch guards
      // against an unhandled rejection if a timed-out read later errors when
      // the connection is closed.
      const n = await withTimeout(conn!.read(buf).catch(() => null), 5000);
      if (n === null) return data || null;
      data += decoder.decode(buf.subarray(0, n));
      const nl = data.indexOf("\n");
      if (nl !== -1) {
        const line = data.substring(0, nl);
        data = data.substring(nl + 1);
        return line;
      }
    }
  }

  async function sendLine(line: string): Promise<void> {
    await conn!.write(encoder.encode(line + "\n"));
  }

  try {
    // Handshake
    await sendLine("HELLO:");
    const helloResp = await readLine();
    if (!helloResp || !helloResp.startsWith("HELLO:")) {
      try { conn.close(); } catch { /* ignore */ }
      return { sent: false, confirmed: false, errored: false };
    }

    for (const lfun of lfuns) {
      await sendLine(`LYXCMD:${lfun}`);
      sent = true;
      const resp = await readLine();
      if (!resp) {
        try { conn.close(); } catch { /* ignore */ }
        return { sent, confirmed: false, errored };
      }
      // "Command disabled" means the LFUN isn't needed (e.g. buffer-write
      // when there are no unsaved changes). Treat as success.
      if (resp.startsWith("ERROR:") && !resp.includes("Command disabled")) errored = true;
    }
    // Every command produced a response — the whole sequence is confirmed.
    confirmed = true;

    await sendLine("BYE:");
    try { conn.close(); } catch { /* ignore */ }
    return { sent, confirmed, errored };
  } catch {
    try { conn.close(); } catch { /* ignore */ }
    return { sent, confirmed, errored };
  }
}

// ---------------------------------------------------------------------------
// Windows named pipe transport
// ---------------------------------------------------------------------------

/**
 * Build a full Windows named pipe path from a base path.
 * LyX uses \\.\pipe\<full_filesystem_path_with_backslashes>.in / .out
 */
function winPipePath(basePath: string, suffix: ".in" | ".out"): string {
  // Convert forward slashes to backslashes for the pipe namespace
  const winPath = basePath.replace(/\//g, "\\");
  return `\\\\.\\pipe\\${winPath}${suffix}`;
}

async function sendViaNamedPipe(
  pipeBase: string,
  lfuns: string[],
): Promise<{ sent: boolean; confirmed: boolean; errored: boolean }> {
  const inPipe = winPipePath(pipeBase, ".in");
  const outPipe = winPipePath(pipeBase, ".out");

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const readBuf = new Uint8Array(512);

  // test_report_38 F1 — Server.cpp delivery race: the pipe loop only copies the
  // shared outbuf_ to .out instances when it wakes *after* a reply exists. A
  // .out reader that connects *after* the command is written can consume the
  // wake before the reply is ready, so the reply lands on the *next* connection
  // where the client-name filter discards it → ~50% of responses lost. Verified
  // empirically (2026-08-01) that no client read strategy fixes this reliably —
  // reader-before-reply and keep-open both make it worse (7/8 lost) and raced
  // reads leave the process lingering (dev log 75). So lq is robust instead:
  //   - `sent` — the command was written to .in (LyX accepted and will execute
  //     it; the operation is NOT lost even when the response is).
  //   - `confirmed` — we also received the response (best-effort on Windows).
  //   - `errored` — a confirmed response was a real ERROR (not "Command disabled").
  // Callers treat `sent && !confirmed` as "attempted, unconfirmed" (proceed with
  // a warning) rather than as a failed operation.
  let sent = false;
  let confirmed = false;
  let errored = false;

  async function sendOnce(): Promise<void> {
    // Fresh client name per attempt so a stale response from a previous attempt
    // (flushed by the shared outbuf_ into every .out) is never misattributed.
    const clientName = `lq${Date.now()}`;

    let inFile: Deno.FsFile | null = null;
    try {
      // Timeout: Deno.open on a Windows named pipe blocks indefinitely if no
      // pipe server is listening (CreateFile behavior). Bounded via withTimeout
      // (timer cleared on settle — test_report_34 Finding 8).
      inFile = await withTimeout(Deno.open(inPipe, { write: true }), 5000);
    } catch {
      return; // couldn't even open .in — genuine disconnect, nothing dispatched
    }

    try {
      for (const lfun of lfuns) {
        try {
          // Send command to .in (keep .in open — closing it ends the session)
          await inFile.write(encoder.encode(`LYXCMD:${clientName}:${lfun}\n`));
        } catch {
          // Write failed after a successful open — server likely died mid-call.
          return;
        }
        sent = true;

        // Poll .out: the server needs time to process the command and write the
        // response. Each open-drain-close is a fresh connection whose connect
        // wakes the server loop, which is when it flushes outbuf_ to the .out
        // instances. A lost response surfaces as a later retry of the sequence.
        let response: string | null = null;
        for (const delay of [50, 100, 200, 500, 1000]) {
          await new Promise(r => setTimeout(r, delay));
          response = await tryReadResponse(outPipe, readBuf, decoder, clientName);
          if (response !== null) break;
        }

        if (response === null) return; // incomplete attempt — retry the sequence
        // "Command disabled" means the LFUN isn't needed (e.g. buffer-write
        // when there are no unsaved changes). Treat as success.
        if (response.startsWith("ERROR:") && !response.includes("Command disabled")) errored = true;
      }
      // Every command produced a response — the whole sequence is confirmed.
      confirmed = true;
    } finally {
      try { inFile.close(); } catch { /* ignore */ }
    }
  }

  for (let attempt = 0; attempt < 3 && !confirmed; attempt++) {
    await sendOnce();
  }
  return { sent, confirmed, errored };
}

/**
 * Filter a chunk of .out data down to the last response line addressed to
 * `clientName`. LyX's server accumulates responses for ALL clients in one
 * shared buffer and copies it to every .out instance (Server.cpp
 * WRITING_STATE), so lines must be correlated by client name, not by position
 * (test_report_34 Finding 9). Returns null when no matching line is present.
 */
export function filterResponses(data: string, clientName: string): string | null {
  const lines = data.split("\n").filter(l => l);
  const mine = lines.filter(l =>
    l.startsWith(`INFO:${clientName}:`) || l.startsWith(`ERROR:${clientName}:`));
  return mine.length > 0 ? mine[mine.length - 1] : null;
}

/**
 * Open .out, drain all currently available data, and return the last response
 * line addressed to `clientName` (or null if none arrived yet). Each call is a
 * fresh connection whose connect wakes the Server.cpp loop — which is when it
 * flushes its shared outbuf_ to the .out instances (test_report_38 F1).
 *
 * Draining is essential: without it, stale responses from other clients would
 * persist and be misattributed by a later connection (false REFRESH_PRE_ERROR
 * / false success — test_report_34 Finding 9). Reads here are blocking (until
 * EOF/error, which the server triggers by resetting the instance) — never raced
 * with a timeout, since an abandoned read on a Windows pipe pins the process
 * (dev log 75).
 */
async function tryReadResponse(
  outPipe: string,
  buf: Uint8Array,
  decoder: TextDecoder,
  clientName: string,
): Promise<string | null> {
  let outFile: Deno.FsFile | null = null;
  try {
    outFile = await withTimeout(Deno.open(outPipe, { read: true }), 2000);
  } catch {
    return null;
  }

  try {
    let data = "";
    // Drain everything currently available so stale responses from other
    // clients don't persist into the next connection.
    for (let attempt = 0; attempt < 40; attempt++) {
      try {
        const n = await outFile.read(buf);
        if (n === null || n === 0) break;
        data += decoder.decode(buf.subarray(0, n));
      } catch (e) {
        if (e instanceof Deno.errors.BrokenPipe ||
            (e instanceof Error && e.message.includes("os error 233"))) {
          break; // Pipe disconnected
        }
        throw e;
      }
      await new Promise(r => setTimeout(r, 30));
    }

    return filterResponses(data, clientName);
  } finally {
    try { outFile.close(); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Connect to a running LyX instance and send a sequence of LFUN commands.
 *
 * Returns `{ sent, confirmed, errored }`:
 * - `sent` — the command was dispatched to LyX (written to the pipe/socket).
 *   On Windows this is the reliable part: Server.cpp executes the LFUN even
 *   when the response is lost to the delivery race (test_report_38 F1).
 * - `confirmed` — every command also produced a response (INFO or ERROR).
 *   This is best-effort on Windows (see F1); a false `confirmed` with a true
 *   `sent` means the operation ran but the confirmation was lost.
 * - `errored` — a confirmed response was a real ERROR (not "Command disabled").
 *
 * @param lfuns - Array of LFUN command strings (e.g., ["buffer-switch /path/file.lyx", "buffer-reload"])
 */
export async function sendLyxCommands(
  lfuns: string[],
): Promise<{ sent: boolean; confirmed: boolean; errored: boolean }> {
  try {
    if (Deno.build.os === "windows") {
      const pipeBase = discoverWindowsPipePath();
      if (!pipeBase) return { sent: false, confirmed: false, errored: false };
      return await sendViaNamedPipe(pipeBase, lfuns);
    } else {
      const socketPath = discoverUnixSocket();
      if (!socketPath) return { sent: false, confirmed: false, errored: false };
      return await sendViaUnixSocket(socketPath, lfuns);
    }
  } catch {
    // Timeout or other transport error — LyX is unreachable.
    // Caller should degrade gracefully (mutation was already committed).
    return { sent: false, confirmed: false, errored: false };
  }
}

/**
 * Check if a running LyX instance with LyXServer enabled is reachable.
 * Used at `lq init` time to verify configuration.
 */
export function checkLyxServerAvailable(): boolean {
  if (Deno.build.os === "windows") {
    return discoverWindowsPipePath() !== null;
  }
  return discoverUnixSocket() !== null;
}
