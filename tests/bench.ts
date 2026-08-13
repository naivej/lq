/**
 * lq bench — Performance benchmarks for all lq CLI commands.
 * Run from the repo root or lq/: deno bench -A --no-check tests/bench.ts
 *
 * Uses Deno.bench() for built-in warmup, statistical analysis, and reporting.
 * Mutation commands use temp file copies to avoid polluting fixtures.
 */

import { fromFileUrl } from "@std/path";

// Module-relative (cwd-independent) so bench runs from the repo root or lq/.
const MAIN_TS = fromFileUrl(new URL("../main.ts", import.meta.url));
const FIXTURES = fromFileUrl(new URL("./fixtures", import.meta.url));

const SMALL = `${FIXTURES}/my_template.lyx`;
const MEDIUM = `${FIXTURES}/Articles/Springer_Nature_Journals.lyx`;
const LARGE = `${FIXTURES}/Modules/Fancy_Colored_Boxes.lyx`;
const BIB_FIXTURE = `${FIXTURES}/Books/KOMA-Script_Book.lyx`;
// Chapter-based large fixture used by the DL105 F3 :until perf work and the
// R1 regression bench (DL106).
const USERGUIDE = `${FIXTURES}/Help/UserGuide.lyx`;

const TMP = Deno.env.get("TMPDIR") || Deno.env.get("TEMP") || "/tmp";
const TMP_DIR = `${TMP}/lq_bench`;

const RAW_SNIPPET = "\\begin_layout Standard\nbenchmark\n\\end_layout\n";

// — Helpers —

function lq(args: string[]): Deno.Command {
  return new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "--no-check", MAIN_TS, ...args],
    stdout: "null",
    stderr: "null",
  });
}

/** Run command and wait for it to finish. Returns exit code. */
async function run(args: string[]): Promise<{ code: number; success: boolean }> {
  const cmd = lq(args);
  const { code } = await cmd.output();
  return { code, success: code === 0 };
}

/** Copy fixture to temp, returning the temp path. */
async function copyFixture(fixture: string): Promise<string> {
  await Deno.mkdir(TMP_DIR, { recursive: true });
  const name = fixture.replace(/\\/g, "/").split("/").pop()!;
  const tmp = `${TMP_DIR}/${name}`;
  await Deno.copyFile(fixture, tmp);
  return tmp;
}

// CLI arg order is: <command> <file> <selector> [...rest]

// — Read benchmarks (no mutation) —

Deno.bench("read | small  | layout", async () => {
  await run(["read", SMALL, "layout"]);
});

Deno.bench("read | medium | layout[Standard]", async () => {
  await run(["read", MEDIUM, "layout[Standard]"]);
});

Deno.bench("read | large  | layout", async () => {
  await run(["read", LARGE, "layout"]);
});

Deno.bench("read | large  | :contains(a)", async () => {
  await run(["read", LARGE, ":contains(a)"]);
});

Deno.bench("read | small  | :contains(the)", async () => {
  await run(["read", SMALL, ":contains(the)"]);
});

Deno.bench("read | medium | :first", async () => {
  await run(["read", MEDIUM, "layout:first"]);
});

// DL106 R1: guard against a regression of the DL105 F3 :until optimization
// (anchor-grouping + firstBoundary). Baseline: ~0.17 s CLI wall (was ~3.3 s
// pre-F3). Deno.bench enforces no threshold — the entry's presence plus the
// recorded baseline is the guard.
Deno.bench("read | large  | layout[Chapter] ~ layout:until(layout[Chapter])", async () => {
  await run(["read", USERGUIDE, "layout[Chapter] ~ layout:until(layout[Chapter])", "--count"]);
});

// — Dump benchmarks —

Deno.bench("dump | small  | full CST", async () => {
  await run(["dump", SMALL]);
});

Deno.bench("dump | medium | full CST", async () => {
  await run(["dump", MEDIUM]);
});

Deno.bench("dump | large  | full CST", async () => {
  await run(["dump", LARGE]);
});

// — Schema benchmarks (no mutation) —

Deno.bench("schema | small | article class", async () => {
  await run(["schema", SMALL]);
});

Deno.bench("schema | large | custom module", async () => {
  await run(["schema", LARGE]);
});

// — Bib benchmark (no mutation) —

Deno.bench("bib | book | extract keys", async () => {
  await run(["bib", BIB_FIXTURE]);
});

// — Mutation benchmarks —

/** args[0] is the command name, the rest follow the file path: lq <cmd> <tmp> <selector> [...rest] */
async function benchMutate(
  fixture: string,
  args: string[],
): Promise<void> {
  const tmp = await copyFixture(fixture);
  // If args contain --raw, write the content to a temp file and use --raw-file
  const processedArgs = [...args];
  let rawTmp: string | null = null;
  const rawFileIdx = processedArgs.indexOf("--raw");
  if (rawFileIdx !== -1) {
    const rawContent = processedArgs[rawFileIdx + 1];
    rawTmp = await Deno.makeTempFile({ suffix: ".raw" });
    await Deno.writeTextFile(rawTmp, rawContent);
    processedArgs[rawFileIdx] = "--raw-file";
    processedArgs[rawFileIdx + 1] = rawTmp;
  }
  try {
    const { success } = await run([processedArgs[0], tmp, ...processedArgs.slice(1)]);
    if (!success) throw new Error(`Mutation failed: lq ${processedArgs.join(" ")}`);
    // Verify the file is still valid LyX after mutation
    const verify = lq(["read", tmp, "layout"]);
    const { code } = await verify.output();
    if (code !== 0) throw new Error("Mutation left file unreadable");
  } finally {
    await Deno.remove(tmp).catch(() => {});
    if (rawTmp) await Deno.remove(rawTmp).catch(() => {});
  }
}

Deno.bench("set | small | property text", async () => {
  await benchMutate(SMALL, ["set", "property[author]", "Benchmark Author"]);
});

Deno.bench("set | medium | property text", async () => {
  await benchMutate(MEDIUM, ["set", "property[textclass]", "Benchmark Author"]);
});

Deno.bench("delete | small | layout textnode", async () => {
  await benchMutate(SMALL, ["delete", "layout:first"]);
});

Deno.bench("insert | small | --raw 11 nodes", async () => {
  await benchMutate(SMALL, ["insert", "layout[Standard]", "after", "--raw", RAW_SNIPPET]);
});

Deno.bench("insert | medium | --raw 45 nodes", async () => {
  await benchMutate(MEDIUM, ["insert", "layout[Standard]", "after", "--raw", RAW_SNIPPET]);
});

Deno.bench("insert | small | --layout 1 node", async () => {
  await benchMutate(SMALL, [
    "insert",
    "layout[Standard]:first",
    "after",
    "--layout",
    "Standard",
    "--text",
    "bench",
  ]);
});

// — Dev log 90: see-all matching on a large TRACKED fixture —
// The stock fixtures are largely untracked, so generate a tracked variant of
// LARGE once (copy + a tracked --find that injects change markers at scale),
// then bench the see-all mutation and :change() query paths against it.

const TRACKED_LARGE = `${TMP_DIR}/tracked_large_src.lyx`;
const TRACKED_HOME = `${TMP_DIR}/bench_home_tracked`;

async function ensureTrackedLarge(): Promise<string> {
  try {
    await Deno.stat(TRACKED_LARGE);
    return TRACKED_LARGE;
  } catch {
    const src = await copyFixture(LARGE);
    // Inject tracked regions: replace every "The" with tracking on, producing
    // \change_deleted{The}\change_inserted{the} pairs across the document.
    // Tracking is a config setting, so run under a temp HOME with it enabled.
    await Deno.mkdir(`${TRACKED_HOME}/.lq`, { recursive: true });
    await Deno.writeTextFile(
      `${TRACKED_HOME}/.lq/config.json`,
      JSON.stringify({ trackChanges: true, refresh: "none" }),
    );
    const cmd = new Deno.Command(Deno.execPath(), {
      args: ["run", "-A", "--no-check", MAIN_TS, "set", src, "layout[Standard]", "the", "--find", "The"],
      stdout: "null",
      stderr: "null",
      env: { ...Deno.env.toObject(), HOME: TRACKED_HOME, USERPROFILE: TRACKED_HOME },
    });
    const { code } = await cmd.output();
    if (code !== 0) {
      await Deno.remove(src).catch(() => {});
      throw new Error("Failed to generate tracked fixture");
    }
    await Deno.rename(src, TRACKED_LARGE);
    return TRACKED_LARGE;
  }
}

Deno.bench("set | large tracked | --find inside \\change_deleted (see-all)", async () => {
  // benchMutate's copyFixture targets TMP_DIR/<basename>, which collides with
  // the canonical tracked fixture — copy to a distinct temp name instead.
  const src = await ensureTrackedLarge();
  const tmp = `${TMP_DIR}/tracked_large_bench_${Deno.pid}.lyx`;
  await Deno.copyFile(src, tmp);
  try {
    const { success } = await run(["set", tmp, "layout[Standard]", "Z", "--find", "the"]);
    if (!success) throw new Error("Mutation failed");
    const verify = lq(["read", tmp, "layout"]);
    const { code } = await verify.output();
    if (code !== 0) throw new Error("Mutation left file unreadable");
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
});

Deno.bench("read | large tracked | text:change(deleted)", async () => {
  await run(["read", await ensureTrackedLarge(), "text:change(deleted)"]);
});
