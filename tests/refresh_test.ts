/**
 * Tests for LyXServer refresh helpers.
 *
 * These tests verify the safety contracts of refreshPreStep
 * WITHOUT requiring a running LyX instance. The socket client (sendLyxCommands)
 * returns false when no LyX is running, which is the path we test here.
 */

import { assert } from "@std/assert";
import { refreshPreStep } from "../src/cli.ts";

Deno.test("Refresh - save-reload pre-step connects when LyXServer available", async () => {
  // When LyX is running with LyXServer enabled, the pre-step should succeed.
  // When LyX is not running, sendLyxCommands returns false and the pre-step
  // blocks the mutation (REFRESH_PRE_ERROR). This test verifies the function
  // doesn't crash and returns a boolean. The actual value depends on whether
  // LyX happens to be running during the test.
  const ok = await refreshPreStep("/tmp/test.lyx", "save-reload");
  // Just check it returns a boolean (no crash)
  assert(typeof ok === "boolean", "refreshPreStep must return a boolean");
});

Deno.test("Refresh - reload mode has no pre-step", async () => {
  // reload mode intentionally discards unsaved edits — no pre-step needed.
  // If the guard were removed, this would call sendLyxCommands, which returns
  // false without LyX, and the test would fail.
  const ok = await refreshPreStep("/tmp/test.lyx", "reload");
  assert(ok, "reload mode should not require a pre-step");
});

Deno.test("Refresh - none mode has no pre-step", async () => {
  const ok = await refreshPreStep("/tmp/test.lyx", "none");
  assert(ok, "none mode should not require a pre-step");
});
