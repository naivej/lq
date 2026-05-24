/**
 * Shared test helpers for lq CLI tests.
 * No Deno.test() calls here — this module is safe to import from any test file.
 */

/** Shape of JSON responses from lq CLI commands. */
export interface CliResult {
  status: "success" | "error";
  code?: string;
  message?: string;
  inserted_nodes?: number;
  modified_nodes?: number;
  deleted_nodes?: number;
  count?: number;
  data?: unknown;
}

/**
 * Run lq CLI with given arguments and return parsed JSON output.
 * Works for any command that outputs JSON (all except --help).
 */
export async function runCliTest(args: string[]): Promise<CliResult> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "main.ts", ...args],
    stdout: "piped",
    stderr: "piped",
  });
  const { stdout } = await command.output();
  const outputStr = new TextDecoder().decode(stdout).trim();
  try {
    return JSON.parse(outputStr);
  } catch (_e) {
    return { status: "error", message: "Failed to parse CLI output: " + outputStr };
  }
}

/**
 * Run lq CLI and return raw stdout/stderr plus exit code.
 * For commands that output plain text (e.g. --help).
 */
export async function runCliRaw(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const command = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", "main.ts", ...args],
    stdout: "piped",
    stderr: "piped",
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
 */
export async function runCliWithEnv(args: string[], env: Record<string, string>): Promise<CliResult> {
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
    return { status: "error", message: "Failed to parse CLI output: " + outputStr };
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
