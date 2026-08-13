import { assertEquals } from "@std/assert";
import { expandGlob } from "@std/fs";
import { fromFileUrl } from "@std/path";
import { parse } from "../src/parser.ts";
import { serialize } from "../src/serializer.ts";

const FIXTURES = fromFileUrl(new URL("./fixtures", import.meta.url));

Deno.test("Lossless Round-Trip Parsing Test", { timeout: 30000 }, async (t) => {
  for await (const file of expandGlob("**/*.lyx", { root: FIXTURES })) {
    await t.step(file.name, async () => {
      const originalText = await Deno.readTextFile(file.path);
      
      // Normalize line endings to LF for consistent memory processing
      const normalizedOriginal = originalText.replace(/\r\n/g, "\n");
      
      const ast = parse(normalizedOriginal);
      const serialized = serialize(ast);
      
      // The serialized string should EXACTLY match the normalized original string
      assertEquals(serialized, normalizedOriginal, `Serialization mismatch for ${file.name}`);
    });
  }
});
