/**
 * Tests for LyXServer refresh helpers.
 *
 * These tests verify the safety contracts of refreshPreStep
 * WITHOUT requiring a running LyX instance. The socket client (sendLyxCommands)
 * returns false when no LyX is running, which is the path we test here.
 */

import { assert, assertEquals } from "@std/assert";
import { refreshPreStep } from "../src/cli.ts";
import { buildPipeCommand, filterResponses } from "../src/lyxserver.ts";

Deno.test("Refresh - save-reload pre-step returns a status", { timeout: 10000 }, async () => {
  // The pre-step returns one of "ok" | "disconnect" | "unconfirmed" | "error"
  // (test_report_38 F1 Option A): a genuine disconnect aborts, an unconfirmed
  // (dispatched but lost) save proceeds with a warning, a confirmed error
  // aborts. This test verifies the function doesn't crash and returns a valid
  // status; the actual value depends on whether LyX happens to be running.
  const status = await refreshPreStep("/tmp/test.lyx", "save-reload");
  assert(
    ["ok", "disconnect", "unconfirmed", "error"].includes(status),
    `refreshPreStep must return a status string, got: ${status}`,
  );
});

Deno.test("Refresh - reload mode has no pre-step", { timeout: 5000 }, async () => {
  // reload mode intentionally discards unsaved edits — no pre-step needed.
  // If the guard were removed, this would call sendLyxCommands, which returns
  // false without LyX, and the test would fail.
  const ok = await refreshPreStep("/tmp/test.lyx", "reload");
  assert(ok, "reload mode should not require a pre-step");
});

Deno.test("Refresh - none mode has no pre-step", { timeout: 5000 }, async () => {
  const ok = await refreshPreStep("/tmp/test.lyx", "none");
  assert(ok, "none mode should not require a pre-step");
});

// DL82 (test_report_34 Finding 9): LyX's server flushes ALL clients' responses
// into every .out instance; lq must correlate responses by client name, not
// position, and ignore stale lines from other clients.
Deno.test("Refresh - .out responses filtered by client name", () => {
  const mine = "lq1785486000000";
  const other = "lq1785485999000";

  // Stale lines from other clients must be ignored even if they appear after
  // this client's line in the buffer.
  const data = [
    `ERROR:${other}:buffer-reload:Command disabled`,
    `INFO:${mine}:buffer-write:`,
    `ERROR:${other}:buffer-switch X:Document not loaded`,
  ].join("\n");
  assertEquals(
    filterResponses(data, mine),
    `INFO:${mine}:buffer-write:`,
    "must return the last line for THIS client",
  );

  // An ERROR line for this client is also returned (caller decides success).
  assertEquals(
    filterResponses(`ERROR:${mine}:buffer-reload:Command disabled`, mine),
    `ERROR:${mine}:buffer-reload:Command disabled`,
  );

  // No line for this client yet → null (keep polling).
  assertEquals(filterResponses(data, "lq1785487000000"), null);
});

// DL82 (test_report_34 Finding 9): the matching line must be matched by client
// name — a response for a client whose name is a PREFIX of another must not be
// conflated.
Deno.test("Refresh - client-name filter is exact (not prefix)", () => {
  const data = `INFO:lq123:buffer-write:\nINFO:lq1234:buffer-write:`;
  assertEquals(filterResponses(data, "lq123"), `INFO:lq123:buffer-write:`);
  assertEquals(filterResponses(data, "lq1234"), `INFO:lq1234:buffer-write:`);
});

// Dev log 128: the Windows pipe transport must send the colon-separated
// func:arg form so a drive letter in an absolute path doesn't truncate the
// func field (Server.cpp Server::callback parses the func field up to the next
// ':' and the arg field up to '\n'). Overturns dev log 28's "no escape
// mechanism" conclusion.
Deno.test("Refresh - pipe command uses colon-separated func:arg form", () => {
  const c = "lq123";
  // No argument → bare func, no trailing colon (unchanged).
  assertEquals(buildPipeCommand(c, "buffer-write"), `LYXCMD:${c}:buffer-write\n`);
  // Windows absolute path → colon form keeps the drive letter in the argument.
  assertEquals(
    buildPipeCommand(c, "buffer-switch C:\\Users\\Shifu\\file.lyx"),
    `LYXCMD:${c}:buffer-switch:C:\\Users\\Shifu\\file.lyx\n`,
  );
  // Path containing spaces is preserved (argument runs to '\n').
  assertEquals(
    buildPipeCommand(c, "buffer-switch C:\\Users\\Shifu\\LyX 2.5\\file.lyx"),
    `LYXCMD:${c}:buffer-switch:C:\\Users\\Shifu\\LyX 2.5\\file.lyx\n`,
  );
});

Deno.test("Refresh - mock server: save-reload returns ok (Unix socket)", { ignore: Deno.build.os === "windows", timeout: 15000 }, async () => {
  // Backlog 17 / dev log 87 F1: a controllable server behind the $LYXSOCKET
  // override proves refreshPreStep(file, "save-reload") returns "ok" — not just
  // "disconnect" (no LyX) — and that the expected LFUNs were received.
  // Deterministic and GUI-free.
  //
  // Guarded to Unix: Deno.listen with the unix transport is unsupported on
  // Windows (op_net_listen_unix), so the Windows named-pipe path cannot be
  // mocked in-test — it is covered by live tests instead (dev log 87 F1/F10).
  const tmp = Deno.makeTempDirSync();
  const socketPath = `${tmp}/lyxsocket`;
  const filePath = `${tmp}/doc.lyx`;
  const originalLyxSocket = Deno.env.get("LYXSOCKET");
  await Deno.writeTextFile(filePath,
    "#LyX 2.5 created this file.\n" +
    "\\begin_document\n\\begin_header\n\\end_header\n" +
    "\\begin_body\n\\begin_layout Standard\nhi\n\\end_layout\n\\end_body\\end_document\n");
  try {
    Deno.env.set("LYXSOCKET", socketPath);
    const listener = Deno.listen({ path: socketPath, transport: "unix" });
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const buf = new Uint8Array(4096);
    let sawBufferSwitch = false;
    let sawBufferWrite = false;
    const serverDone = (async () => {
      const conn = await listener.accept();
      let data = "";
      try {
        while (true) {
          const n = await conn.read(buf);
          if (n === null) break;
          data += decoder.decode(buf.subarray(0, n));
          let nl: number;
          while ((nl = data.indexOf("\n")) !== -1) {
            const line = data.slice(0, nl).trim();
            data = data.slice(nl + 1);
            if (line.startsWith("HELLO:")) {
              await conn.write(encoder.encode("HELLO:\n"));
            } else if (line.startsWith("LYXCMD:")) {
              const lfun = line.slice("LYXCMD:".length);
              if (lfun.includes("buffer-switch")) sawBufferSwitch = true;
              if (lfun.includes("buffer-write")) sawBufferWrite = true;
              await conn.write(encoder.encode(`INFO:${lfun}:\n`));
            } else if (line.startsWith("BYE:")) {
              break;
            }
          }
        }
      } finally {
        try { conn.close(); } catch { /* ignore */ }
        listener.close();
      }
    })();
    const status = await refreshPreStep(filePath, "save-reload");
    await serverDone;
    assertEquals(status, "ok", "save-reload must report ok against a responding server");
    assertEquals(sawBufferSwitch, true, "server must receive buffer-switch before the save");
    assertEquals(sawBufferWrite, true, "server must receive buffer-write");
  } finally {
    if (originalLyxSocket === undefined) Deno.env.delete("LYXSOCKET");
    else Deno.env.set("LYXSOCKET", originalLyxSocket);
    try { Deno.removeSync(tmp, { recursive: true }); } catch { /* ignore */ }
  }
});
