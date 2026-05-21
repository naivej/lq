/**
 * Tests for LyXServer refresh helpers.
 *
 * These tests verify the safety contracts of refreshPreStep
 * WITHOUT requiring a running LyX instance. The socket client (sendLyxCommands)
 * returns false when no LyX is running, which is the path we test here.
 */

import { assert } from "@std/assert";
import { refreshPreStep } from "../src/cli.ts";

Deno.test("Refresh - save-reload pre-step blocks without LyXServer", async () => {
  // With no LyX running, sendLyxCommands returns false.
  // refreshPreStep must propagate this failure to prevent data loss.
  const ok = await refreshPreStep("/tmp/test.lyx", "save-reload");
  assert(!ok, "save-reload pre-step must return false when LyXServer unavailable");
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
