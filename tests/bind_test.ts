import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  bindDirFromLayouts,
  formatBindSequence,
  loadShortcutMap,
  lookupShortcut,
} from "../src/bind.ts";
import { getDefaultLayoutsDir } from "../src/schema.ts";

Deno.test("formatBindSequence - CUA portable keys", () => {
  assertEquals(formatBindSequence("C-m"), "Ctrl+M");
  assertEquals(formatBindSequence("C-S-v"), "Ctrl+Shift+V");
  assertEquals(formatBindSequence("M-m m"), "Alt+M M");
  assertEquals(formatBindSequence("C-Insert"), "Ctrl+Insert");
});

Deno.test("loadShortcutMap - cua.bind resolves math-mode and buffer-new", async () => {
  const layoutsDir = await getDefaultLayoutsDir();
  const bindDir = bindDirFromLayouts(layoutsDir);
  const map = await loadShortcutMap(bindDir);
  assertEquals(lookupShortcut(map, "buffer-new", false), "Ctrl+N");
  const math = lookupShortcut(map, "math-mode", false);
  assertEquals(math, "Ctrl+M");
  const all = lookupShortcut(map, "math-mode", true);
  assertStringIncludes(all ?? "", "Ctrl+M");
  assertEquals(lookupShortcut(new Map(), "math-mode", false), undefined);
  assertEquals(await loadShortcutMap(undefined), new Map());
});
