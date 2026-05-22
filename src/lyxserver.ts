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

async function sendViaUnixSocket(socketPath: string, lfuns: string[]): Promise<boolean> {
  let conn: Deno.Conn | null = null;
  try {
    conn = await Deno.connect({ path: socketPath, transport: "unix" });
  } catch {
    return false;
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const buf = new Uint8Array(4096);

  async function readLine(): Promise<string | null> {
    let data = "";
    while (true) {
      const n = await conn!.read(buf);
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
      return false;
    }

    for (const lfun of lfuns) {
      await sendLine(`LYXCMD:${lfun}`);
      const resp = await readLine();
      if (!resp) {
        try { conn.close(); } catch { /* ignore */ }
        return false;
      }
      // "Command disabled" means the LFUN isn't needed (e.g. buffer-write
      // when there are no unsaved changes). Treat as success.
      if (resp.startsWith("ERROR:") && !resp.includes("Command disabled")) {
        try { conn.close(); } catch { /* ignore */ }
        return false;
      }
    }

    await sendLine("BYE:");
    try { conn.close(); } catch { /* ignore */ }
    return true;
  } catch {
    try { conn.close(); } catch { /* ignore */ }
    return false;
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

async function sendViaNamedPipe(pipeBase: string, lfuns: string[]): Promise<boolean> {
  const inPipe = winPipePath(pipeBase, ".in");
  const outPipe = winPipePath(pipeBase, ".out");

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const readBuf = new Uint8Array(512);
  // Unique client name per session avoids stale responses from previous
  // connections. LyX buffers responses per client name indefinitely.
  const clientName = `lq${Date.now()}`;

  let inFile: Deno.FsFile | null = null;

  try {
    inFile = await Deno.open(inPipe, { write: true });
  } catch {
    return false;
  }

  try {
    for (const lfun of lfuns) {
      // Send command to .in (keep .in open — closing it ends the session)
      await inFile.write(encoder.encode(`LYXCMD:${clientName}:${lfun}\n`));

      // Poll .out: the server needs time to process the command and write
      // the response. Opening .out too early gets an empty/disconnected pipe.
      // Opening too late misses the response before the server disconnects.
      let response: string | null = null;
      for (const delay of [50, 100, 200, 500, 1000]) {
        await new Promise(r => setTimeout(r, delay));
        response = await tryReadResponse(outPipe, readBuf, decoder);
        if (response !== null) break;
      }

      if (!response) return false;
      // "Command disabled" means the LFUN isn't needed (e.g. buffer-write
      // when there are no unsaved changes). Treat as success.
      if (response.startsWith("ERROR:") && !response.includes("Command disabled")) return false;
    }

    return true;
  } catch {
    return false;
  } finally {
    try { inFile.close(); } catch { /* ignore */ }
  }
}

/** Open .out, read all available data, return the last line or null. */
async function tryReadResponse(
  outPipe: string,
  buf: Uint8Array,
  decoder: TextDecoder,
): Promise<string | null> {
  let outFile: Deno.FsFile | null = null;
  try {
    outFile = await Deno.open(outPipe, { read: true });
  } catch {
    return null;
  }

  try {
    let data = "";
    for (let attempt = 0; attempt < 20; attempt++) {
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
      // If we got data ending with newline, we have at least one complete response
      if (data.includes("\n")) break;
      await new Promise(r => setTimeout(r, 30));
    }

    const lines = data.split("\n").filter(l => l);
    return lines.length > 0 ? lines[lines.length - 1] : null;
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
 * Returns true if all commands succeeded, false if any failed.
 * This is best-effort: errors are not thrown, just returned.
 *
 * @param lfuns - Array of LFUN command strings (e.g., ["buffer-switch /path/file.lyx", "buffer-reload"])
 * @returns true if LyX was reachable and all commands returned INFO (not ERROR)
 */
export async function sendLyxCommands(lfuns: string[]): Promise<boolean> {
  if (Deno.build.os === "windows") {
    const pipeBase = discoverWindowsPipePath();
    if (!pipeBase) return false;
    return await sendViaNamedPipe(pipeBase, lfuns);
  } else {
    const socketPath = discoverUnixSocket();
    if (!socketPath) return false;
    return await sendViaUnixSocket(socketPath, lfuns);
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
