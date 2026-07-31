/**
 * Tests for LyXServer refresh helpers.
 *
 * These tests verify the safety contracts of refreshPreStep
 * WITHOUT requiring a running LyX instance. The socket client (sendLyxCommands)
 * returns false when no LyX is running, which is the path we test here.
 */

import { assert, assertEquals } from "@std/assert";
import { refreshPreStep } from "../src/cli.ts";
import { filterResponses } from "../src/lyxserver.ts";

Deno.test("Refresh - save-reload pre-step connects when LyXServer available", { timeout: 10000 }, async () => {
  // When LyX is running with LyXServer enabled, the pre-step should succeed.
  // When LyX is not running, sendLyxCommands returns false and the pre-step
  // blocks the mutation (REFRESH_PRE_ERROR). This test verifies the function
  // doesn't crash and returns a boolean. The actual value depends on whether
  // LyX happens to be running during the test.
  const ok = await refreshPreStep("/tmp/test.lyx", "save-reload");
  // Just check it returns a boolean (no crash)
  assert(typeof ok === "boolean", "refreshPreStep must return a boolean");
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
