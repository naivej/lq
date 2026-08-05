import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import { runCliWithEnv } from "./helpers.ts";
import {
  findLocalStateRoot,
  getUserHomeDir,
  resolveInitStatePaths,
  resolveStatePaths,
} from "../src/paths.ts";

const FIXTURE = new URL("./fixtures/my_template.lyx", import.meta.url);

async function copyFixture(name: string): Promise<string> {
  const tempDir = await Deno.makeTempDir({ prefix: "lq_project_state_file" });
  const filePath = path.join(tempDir, name);
  await Deno.copyFile(FIXTURE, filePath);
  return filePath;
}

Deno.test("State paths - nearest local root wins over global fallback", async () => {
  const project = await Deno.makeTempDir({ prefix: "lq_state_project" });
  const fallbackProject = await Deno.makeTempDir({ prefix: "lq_state_fallback" });
  const nested = path.join(project, "src", "nested");
  await Deno.mkdir(nested, { recursive: true });
  await Deno.mkdir(path.join(project, ".lq"));

  try {
    const globalHome = path.join(project, "home");
    const local = await resolveStatePaths(nested, { get: name => name === "HOME" ? globalHome : undefined });
    assert(local);
    assertEquals(local.scope, "local");
    assertEquals(local.root, path.join(project, ".lq"));

    await Deno.mkdir(path.join(project, "src", ".lq"));
    const nearest = await findLocalStateRoot(nested);
    assertEquals(nearest, path.join(project, "src", ".lq"));

    const noLocal = await resolveStatePaths(
      fallbackProject,
      { get: name => name === "HOME" ? globalHome : undefined },
    );
    assert(noLocal);
    assertEquals(noLocal.scope, "global");
    assertEquals(noLocal.root, path.join(globalHome, ".lq"));
  } finally {
    await Deno.remove(project, { recursive: true });
    await Deno.remove(fallbackProject, { recursive: true });
  }
});

Deno.test("State paths - local init target is CWD when no marker exists", async () => {
  const project = await Deno.makeTempDir({ prefix: "lq_state_init_project" });
  try {
    const state = await resolveInitStatePaths(false, project, Deno.env);
    assert(state);
    assertEquals(state.scope, "local");
    assertEquals(state.root, path.join(project, ".lq"));
    assertEquals(getUserHomeDir({ get: () => undefined }), null);
  } finally {
    await Deno.remove(project, { recursive: true });
  }
});

Deno.test("CLI - local init creates local config without copying global values", { timeout: 10000 }, async () => {
  const project = await Deno.makeTempDir({ prefix: "lq_local_init_project" });
  const globalHome = await Deno.makeTempDir({ prefix: "lq_local_init_home" });
  const layoutsDir = await Deno.makeTempDir({ prefix: "lq_local_init_layouts" });
  try {
    await Deno.mkdir(path.join(project, ".lq"));
    await Deno.mkdir(path.join(project, "src"));
    await Deno.mkdir(path.join(globalHome, ".lq"), { recursive: true });
    await Deno.writeTextFile(
      path.join(globalHome, ".lq", "config.json"),
      JSON.stringify({
        layoutsDir,
        refresh: "reload",
        trackChanges: false,
        maxCacheEntries: 7,
        authorName: "global user",
      }),
    );

    const created = await runCliWithEnv(
      ["init", "--layouts-dir", layoutsDir],
      { HOME: globalHome, USERPROFILE: globalHome },
      project,
    );
    assertEquals(created.scope, "local");
    assertEquals(created.action, "created");
    assertEquals(created.configPath, path.join(project, ".lq", "config.json"));
    assertEquals((created.data as Record<string, unknown>).trackChanges, true);
    assertEquals((created.data as Record<string, unknown>).refresh, "none");
    assertEquals((created.data as Record<string, unknown>).authorName, "lq user");
    assertEquals((created.data as Record<string, unknown>).maxCacheEntries, 50);

    const globalConfig = JSON.parse(await Deno.readTextFile(path.join(globalHome, ".lq", "config.json")));
    assertEquals(globalConfig.trackChanges, false);
    assertEquals(globalConfig.authorName, "global user");

    const read = await runCliWithEnv(
      ["init"],
      { HOME: globalHome, USERPROFILE: globalHome },
      path.join(project, "src"),
    );
    assertEquals(read.scope, "local");
    assertEquals(read.action, "read");
    assertEquals((read.data as Record<string, unknown>).trackChanges, true);

    const updated = await runCliWithEnv(
      ["init", "--track-changes", "off"],
      { HOME: globalHome, USERPROFILE: globalHome },
      project,
    );
    assertEquals(updated.action, "updated");
    assertEquals((updated.data as Record<string, unknown>).trackChanges, false);
    assertEquals((updated.data as Record<string, unknown>).layoutsDir, layoutsDir);
  } finally {
    await Deno.remove(project, { recursive: true });
    await Deno.remove(globalHome, { recursive: true });
    await Deno.remove(layoutsDir, { recursive: true });
  }
});

Deno.test("CLI - global init applies options and ignores local target", { timeout: 10000 }, async () => {
  const project = await Deno.makeTempDir({ prefix: "lq_global_init_project" });
  const globalHome = await Deno.makeTempDir({ prefix: "lq_global_init_home" });
  const layoutsDir = await Deno.makeTempDir({ prefix: "lq_global_init_layouts" });
  try {
    await Deno.mkdir(path.join(project, ".lq"), { recursive: true });
    await Deno.mkdir(path.join(globalHome, ".lq"), { recursive: true });
    await Deno.writeTextFile(
      path.join(globalHome, ".lq", "config.json"),
      JSON.stringify({
        layoutsDir,
        refresh: "reload",
        trackChanges: false,
        maxCacheEntries: 7,
        authorName: "old global user",
      }),
    );

    const result = await runCliWithEnv(
      ["init", "--global", "--track-changes", "on", "--author-name", "new global user"],
      { HOME: globalHome, USERPROFILE: globalHome },
      project,
    );
    assertEquals(result.scope, "global");
    assertEquals(result.action, "updated");
    assertEquals(result.configPath, path.join(globalHome, ".lq", "config.json"));
    const config = JSON.parse(await Deno.readTextFile(result.configPath!));
    assertEquals(config.trackChanges, true);
    assertEquals(config.authorName, "new global user");
    assertEquals(config.refresh, "reload");
    assertEquals(config.maxCacheEntries, 7);
    assertEquals(config.layoutsDir, layoutsDir);

    let localConfigExists = true;
    try {
      await Deno.stat(path.join(project, ".lq", "config.json"));
    } catch {
      localConfigExists = false;
    }
    assertFalse(localConfigExists);
  } finally {
    await Deno.remove(project, { recursive: true });
    await Deno.remove(globalHome, { recursive: true });
    await Deno.remove(layoutsDir, { recursive: true });
  }
});

Deno.test("CLI - local init works without a home directory", { timeout: 10000 }, async () => {
  const project = await Deno.makeTempDir({ prefix: "lq_no_home_project" });
  const layoutsDir = await Deno.makeTempDir({ prefix: "lq_no_home_layouts" });
  try {
    await Deno.mkdir(path.join(project, ".lq"));
    const result = await runCliWithEnv(
      ["init", "--layouts-dir", layoutsDir],
      { HOME: "", USERPROFILE: "" },
      project,
    );
    assertEquals(result.scope, "local");
    assertEquals(result.action, "created");
    assertEquals((result.data as Record<string, unknown>).layoutsDir, layoutsDir);
  } finally {
    await Deno.remove(project, { recursive: true });
    await Deno.remove(layoutsDir, { recursive: true });
  }
});

Deno.test("CLI - local cache and undo stay isolated from global state", { timeout: 10000 }, async () => {
  const project = await Deno.makeTempDir({ prefix: "lq_scope_project" });
  const globalHome = await Deno.makeTempDir({ prefix: "lq_scope_home" });
  const filePath = await copyFixture("scope.lyx");
  try {
    await Deno.mkdir(path.join(project, ".lq"), { recursive: true });
    await Deno.writeTextFile(
      path.join(project, ".lq", "config.json"),
      JSON.stringify({ refresh: "none", trackChanges: false, maxCacheEntries: 50 }),
    );
    await Deno.mkdir(path.join(globalHome, ".lq"), { recursive: true });
    await Deno.writeTextFile(
      path.join(globalHome, ".lq", "config.json"),
      JSON.stringify({ refresh: "none", trackChanges: true, maxCacheEntries: 50 }),
    );

    const read = await runCliWithEnv(
      ["read", filePath, "layout[Title]"],
      { HOME: globalHome, USERPROFILE: globalHome },
      project,
    );
    assertEquals(read.code, undefined);

    const localCache = path.join(project, ".lq", "cache");
    const globalCache = path.join(globalHome, ".lq", "cache");
    const localCacheEntries = [...Deno.readDirSync(localCache)].filter(entry => entry.name.endsWith(".cst"));
    assertEquals(localCacheEntries.length, 1);
    let globalCacheExists = true;
    try {
      await Deno.stat(globalCache);
    } catch {
      globalCacheExists = false;
    }
    assertFalse(globalCacheExists);

    await runCliWithEnv(
      ["set", filePath, "layout[Title]", "Local edit"],
      { HOME: globalHome, USERPROFILE: globalHome },
      project,
    );
    const afterSet = await runCliWithEnv(
      ["read", filePath, "layout[Title]", "--text-only"],
      { HOME: globalHome, USERPROFILE: globalHome },
      project,
    );
    assertStringIncludes(afterSet.text!, "layout[Title] Local edit");
    assertFalse(afterSet.text!.includes("\\change_deleted"));

    const undone = await runCliWithEnv(
      ["undo", filePath, "layout[Title]"],
      { HOME: globalHome, USERPROFILE: globalHome },
      project,
    );
    assertEquals(undone.method, "snapshot");
    assertStringIncludes(await Deno.readTextFile(filePath), "\nTitle\n");
  } finally {
    await Deno.remove(project, { recursive: true });
    await Deno.remove(globalHome, { recursive: true });
    await Deno.remove(path.dirname(filePath), { recursive: true });
  }
});
