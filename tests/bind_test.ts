import { assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import {
  bindDirFromLayouts,
  formatBindSequence,
  loadShortcutMap,
  loadShortcutMapMerged,
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

Deno.test("loadShortcutMapMerged - user bind prepends over system", async () => {
  const layoutsDir = await getDefaultLayoutsDir();
  const systemBind = bindDirFromLayouts(layoutsDir)!;
  const tmp = await Deno.makeTempDir({ prefix: "lq-bind-user-" });
  try {
    await Deno.writeTextFile(
      path.join(tmp, "cua.bind"),
      '\\bind "C-F12" "math-mode"\n',
    );
    const merged = await loadShortcutMapMerged(systemBind, tmp);
    assertEquals(lookupShortcut(merged, "math-mode", false), "Ctrl+F12");
    assertStringIncludes(lookupShortcut(merged, "math-mode", true) ?? "", "Ctrl+M");
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});
