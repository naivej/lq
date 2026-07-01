/**
 * Shared test helpers for lq CLI tests.
 * No Deno.test() calls here — this module is safe to import from any test file.
 *
 * ## Expected test config
 *
 * Mutation tests (set, delete, insert) expect:
 *   refresh: "none"
 *   trackChanges: false
 *
 * This module isolates tests from the developer's local config by creating
 * a temp ~/.lq/config.json with these safe defaults. Layouts are left unset
 * so lq auto-detects from the system (needed for schema/mutation validation).
 */

/** Shape of JSON responses from lq CLI commands. */
export interface CliResult {
  code?: string;
  message?: string;
  inserted_nodes?: number;
  modified_nodes?: number;
  deleted_nodes?: number;
  count?: number | Record<string, number>;
  text?: string;
  data?: unknown;
}

/**
 * Test config values — safe defaults that make mutation tests deterministic
 * regardless of the developer's local ~/.lq/config.json settings.
 * layoutsDir is inherited from the user's real config (if available) so that
 * schema-dependent validation tests still work.
 */
const TEST_CONFIG_BASE = {
  refresh: "none",
  trackChanges: false,
};

/** Lazily created temp HOME with a known-good .lq/config.json. */
let _testHome: string | null = null;

async function getTestHome(): Promise<string> {
  if (_testHome) return _testHome;
  const tmp = Deno.env.get("TMPDIR") || Deno.env.get("TEMP") || "/tmp";
  _testHome = `${tmp}/lq_test_home_${Deno.pid}`;
  await Deno.mkdir(`${_testHome}/.lq`, { recursive: true });

  // Inherit layoutsDir from user's real config so schema validation works.
  // Only refresh and trackChanges are overridden with safe test defaults.
  let layoutsDir: string | undefined;
  try {
    const realHome = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
    if (realHome) {
      const realConfig = JSON.parse(
        await Deno.readTextFile(`${realHome}/.lq/config.json`),
      );
      if (realConfig.layoutsDir) layoutsDir = realConfig.layoutsDir;
    }
  } catch { /* no user config, that's fine */ }

  await Deno.writeTextFile(
    `${_testHome}/.lq/config.json`,
    JSON.stringify({ ...TEST_CONFIG_BASE, ...(layoutsDir ? { layoutsDir } : {}) }),
  );
  return _testHome;
}

/** Env vars that redirect lq to the isolated test config. */
async function testEnv(): Promise<Record<string, string>> {
  const home = await getTestHome();
  // Override both HOME and USERPROFILE — on Windows with Git Bash, HOME
  // takes priority over USERPROFILE, so we must set both to be safe.
  return { HOME: home, USERPROFILE: home };
}

/**
 * Run lq CLI with given arguments and return parsed JSON output.
 * Uses an isolated test config (refresh=none, trackChanges=false).
 * Works for any command that outputs JSON (all except --help).
 */
export async function runCliTest(args: string[]): Promise<CliResult> {
  const env = await testEnv();
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "main.ts", ...args],
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject(), ...env },
  });
  const { stdout } = await command.output();
  const outputStr = new TextDecoder().decode(stdout).trim();
  try {
    return JSON.parse(outputStr);
  } catch (_e) {
    return { message: "Failed to parse CLI output: " + outputStr };
  }
}

/**
 * Run lq CLI and return raw stdout/stderr plus exit code.
 * Uses an isolated test config (refresh=none, trackChanges=false).
 * For commands that output plain text (e.g. --help).
 */
export async function runCliRaw(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const env = await testEnv();
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "main.ts", ...args],
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject(), ...env },
  });
  const { stdout, stderr, code } = await command.output();
  return {
    stdout: new TextDecoder().decode(stdout).trim(),
    stderr: new TextDecoder().decode(stderr).trim(),
    code,
  };
}

/**
 * Run lq CLI with custom environment variables (e.g. fake HOME for init tests).
 * Still uses safe test defaults unless explicitly overridden.
 */
export async function runCliWithEnv(args: string[], env: Record<string, string>): Promise<CliResult> {
  const baseEnv = await testEnv();
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "main.ts", ...args],
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject(), ...baseEnv, ...env },
  });
  const { stdout } = await command.output();
  const outputStr = new TextDecoder().decode(stdout).trim();
  try {
    return JSON.parse(outputStr);
  } catch (_e) {
    return { message: "Failed to parse CLI output: " + outputStr };
  }
}

/**
 * Run lq CLI with a custom test config. Overrides are merged on top of the
 * base test config (refresh=none, trackChanges=false). Each unique config
 * gets its own temp home so different tests don't interfere.
 *
 * Example:
 *   runCliWithConfig(["set", file, "layout[Title]", "New"], { trackChanges: true })
 */
export async function runCliWithConfig(
  args: string[],
  overrides: Partial<{ refresh: string; trackChanges: boolean }>,
): Promise<CliResult> {
  const tmp = Deno.env.get("TMPDIR") || Deno.env.get("TEMP") || "/tmp";
  const key = JSON.stringify(overrides);
  const hash = Array.from(new TextEncoder().encode(key))
    .reduce((h, b) => ((h << 5) - h + b) | 0, 0).toString(36);
  const home = `${tmp}/lq_test_config_${hash}_${Deno.pid}`;

  // Inherit layoutsDir from user's real config
  let layoutsDir: string | undefined;
  try {
    const realHome = Deno.env.get("HOME") || Deno.env.get("USERPROFILE");
    if (realHome) {
      const realConfig = JSON.parse(await Deno.readTextFile(`${realHome}/.lq/config.json`));
      if (realConfig.layoutsDir) layoutsDir = realConfig.layoutsDir;
    }
  } catch { /* no user config */ }

  await Deno.mkdir(`${home}/.lq`, { recursive: true });
  await Deno.writeTextFile(
    `${home}/.lq/config.json`,
    JSON.stringify({
      refresh: "none",
      trackChanges: false,
      ...(layoutsDir ? { layoutsDir } : {}),
      ...overrides,
    }),
  );

  const env = { HOME: home, USERPROFILE: home };
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "main.ts", ...args],
    stdout: "piped",
    stderr: "piped",
    env: { ...Deno.env.toObject(), ...env },
  });
  const { stdout } = await command.output();
  const outputStr = new TextDecoder().decode(stdout).trim();
  try {
    return JSON.parse(outputStr);
  } catch (_e) {
    return { message: "Failed to parse CLI output: " + outputStr };
  }
}

/**
 * Create a modifiable temp copy of the main test fixture.
 */
const FIXTURE = "tests/fixtures/my_template.lyx";

export async function createTempFixture(name: string): Promise<string> {
  const tempDir = Deno.env.get("TMPDIR") || Deno.env.get("TEMP") || "/tmp";
  const tempPath = `${tempDir}/${name}`;
  await Deno.copyFile(FIXTURE, tempPath);
  return tempPath;
}
