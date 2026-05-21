/**
 * Tests for LyXServer refresh helpers.
 *
 * These tests verify the safety contracts of refreshPreStep and refreshPostStep
 * WITHOUT requiring a running LyX instance. The socket client (sendLyxCommands)
 * returns false when no LyX is running, which is the path we test here.
 */

import { assert } from "@std/assert";
import { refreshPreStep, refreshPostStep } from "../src/cli.ts";

Deno.test("Refresh - save-reload pre-step blocks without LyXServer", async () => {
  // With no LyX running, sendLyxCommands returns false.
  // refreshPreStep must propagate this failure to prevent data loss.
  const ok = await refreshPreStep("/tmp/test.lyx", "save-reload");
  assert(!ok, "save-reload pre-step must return false when LyXServer unavailable");
});

Deno.test("Refresh - reload mode has no pre-step", async () => {
  // reload mode intentionally discards unsaved edits — no pre-step needed.
  const ok = await refreshPreStep("/tmp/test.lyx", "reload");
  assert(ok, "reload mode should not require a pre-step");
});

Deno.test("Refresh - none mode has no pre-step", async () => {
  const ok = await refreshPreStep("/tmp/test.lyx", "none");
  assert(ok, "none mode should not require a pre-step");
});

Deno.test("Refresh - post-step does not throw without LyXServer", async () => {
  // refreshPostStep is best-effort — must not throw when socket unavailable.
  try {
    await refreshPostStep("/tmp/test.lyx", "reload");
    // Should complete without throwing
  } catch (e) {
    assert(false, `refreshPostStep should not throw: ${e}`);
  }
});

Deno.test("Refresh - post-step does not throw in save-reload mode", async () => {
  try {
    await refreshPostStep("/tmp/test.lyx", "save-reload");
  } catch (e) {
    assert(false, `refreshPostStep should not throw in save-reload: ${e}`);
  }
});

Deno.test("Refresh - post-step is no-op in none mode", async () => {
  // none mode should exit immediately without attempting socket connection
  try {
    await refreshPostStep("/tmp/test.lyx", "none");
  } catch (e) {
    assert(false, `refreshPostStep should not throw in none mode: ${e}`);
  }
});
