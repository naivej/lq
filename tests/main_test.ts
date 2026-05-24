import { assertEquals } from "@std/assert";
import { expandGlob } from "@std/fs";
import { parse } from "../src/parser.ts";
import { serialize } from "../src/serializer.ts";

Deno.test("Lossless Round-Trip Parsing Test", { timeout: 30000 }, async (t) => {
  for await (const file of expandGlob("tests/fixtures/**/*.lyx")) {
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
