/**
 * LyXServer client module.
 *
 * Communicates with a running LyX instance via the socket-based LyXServer
 * (ServerSocket.cpp). Sends LFUN commands and reads responses.
 *
 * Protocol (from LyX source ServerSocket.cpp):
 *   Client -> LyX:  LYXCMD:<lfung> <args>
 *   LyX -> Client:  INFO:<command>:<result>
 *   or:            ERROR:<command>:<error message>
 *   Handshake:     HELLO: -> HELLO:
 *   Disconnect:    BYE:
 *
 * Socket discovery (from LyX source ServerSocket.cpp):
 *   - $LYXSOCKET environment variable (set by LyX at startup)
 *   - Fallback: scan /tmp/lyx_tmpdirXXXX/lyxsocket (Linux/macOS)
 */

import * as path from "@std/path";

/** Result of a LyXServer command. */
interface LyxResponse {
  ok: boolean;
  message: string;
}

/**
 * Discover the LyX socket path.
 * Returns the socket path, or null if not found.
 */
function discoverSocket(): string | null {
  // 1. Check LYXSOCKET environment variable
  const envSocket = Deno.env.get("LYXSOCKET");
  if (envSocket) {
    return envSocket;
  }

  // 2. Scan temp directories for lyxsocket files
  // LyX creates temp dirs as /tmp/lyx_tmpdir<PID>/lyxsocket
  if (Deno.build.os !== "windows") {
    try {
      const tmpDir = Deno.env.get("TMPDIR") || "/tmp";
      for (const entry of Deno.readDirSync(tmpDir)) {
        if (entry.isDirectory && entry.name.startsWith("lyx_tmpdir")) {
          const socketPath = path.join(tmpDir, entry.name, "lyxsocket");
          try {
            const stat = Deno.statSync(socketPath);
            if (stat.isFile || stat.isSocket) {
              return socketPath;
            }
          } catch {
            // Socket doesn't exist in this temp dir
          }
        }
      }
    } catch {
      // Can't read temp dir
    }
  }

  return null;
}

/**
 * Connect to a running LyX instance and send a sequence of LFUN commands.
 *
 * Returns true if all commands succeeded, false if any failed.
 * This is best-effort: errors are not thrown, just returned.
 *
 * @param lfuns - Array of LFUN command strings (e.g., ["buffer-switch /path/file.lyx", "buffer-reload"])
 * @returns true if the socket was found and all commands returned INFO (not ERROR)
 */
export async function sendLyxCommands(lfuns: string[]): Promise<boolean> {
  const socketPath = discoverSocket();
  if (!socketPath) return false;

  if (Deno.build.os === "windows") {
    // Windows: named pipes not yet implemented in Deno unix socket transport.
    // LyXServer on Windows uses the pipe-based mechanism (Server.cpp),
    // which requires connecting to \\.\pipe\lyxpipe.in / \\.\pipe\lyxpipe.out.
    // For now, skip refresh on Windows.
    return false;
  }

  let conn: Deno.Conn | null = null;
  try {
    conn = await Deno.connect({ path: socketPath, transport: "unix" });
  } catch {
    return false;
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const buf = new Uint8Array(4096);

  // Read a line from the socket (delimited by \n)
  async function readLine(): Promise<string | null> {
    let data = "";
    while (true) {
      const n = await conn!.read(buf);
      if (n === null) return data || null; // EOF
      data += decoder.decode(buf.subarray(0, n));
      const nl = data.indexOf("\n");
      if (nl !== -1) {
        const line = data.substring(0, nl);
        // Push remaining back? No — LyXServer is line-based, one response per line.
        // But we could get partial reads. For now, simple approach.
        data = data.substring(nl + 1);
        return line;
      }
    }
  }

  // Send a line
  async function sendLine(line: string): Promise<void> {
    const encoded = encoder.encode(line + "\n");
    await conn!.write(encoded);
  }

  let allOk = true;

  try {
    // Handshake
    await sendLine("HELLO:");
    const helloResp = await readLine();
    if (!helloResp || !helloResp.startsWith("HELLO:")) {
      // Server not responding properly
      try { conn.close(); } catch { /* ignore */ }
      return false;
    }

    // Send each command
    for (const lfun of lfuns) {
      const cmd = `LYXCMD:${lfun}`;
      await sendLine(cmd);
      const resp = await readLine();
      if (!resp) {
        allOk = false;
        break;
      }
      // Response format: INFO:<cmd>:<message> or ERROR:<cmd>:<message>
      if (resp.startsWith("ERROR:")) {
        allOk = false;
        break;
      }
      // INFO is success — continue
    }

    // Disconnect
    await sendLine("BYE:");
    try { conn.close(); } catch { /* ignore */ }
  } catch {
    allOk = false;
    try { conn.close(); } catch { /* ignore */ }
  }

  return allOk;
}

/**
 * Check if a running LyX instance with LyXServer enabled is reachable.
 * Used at `lq init` time to verify configuration.
 */
export function checkLyxServerAvailable(): boolean {
  return discoverSocket() !== null;
}
