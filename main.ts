import { runCli } from "./src/cli.ts";

if (import.meta.main) {
  await runCli(Deno.args);
}
