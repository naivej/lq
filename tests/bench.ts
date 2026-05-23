/**
 * lq bench — Performance benchmarks for all lq CLI commands.
 * Run from the lq/ directory: deno bench -A --no-check tests/bench.ts
 *
 * Uses Deno.bench() for built-in warmup, statistical analysis, and reporting.
 * Mutation commands use temp file copies to avoid polluting fixtures.
 */

// All paths are relative to cwd (lq/), matching the convention in mutation_test.ts
const MAIN_TS = "main.ts";
const FIXTURES = "tests/fixtures";

const SMALL = `${FIXTURES}/my_template.lyx`;
const MEDIUM = `${FIXTURES}/Articles/Springer_Nature_Journals.lyx`;
const LARGE = `${FIXTURES}/Modules/Fancy_Colored_Boxes.lyx`;
const BIB_FIXTURE = `${FIXTURES}/Books/KOMA-Script_Book.lyx`;

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
