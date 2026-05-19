import { getSchemaForClass } from "../src/schema.ts";
import { assert, assertEquals } from "@std/assert";

const localAppData = Deno.env.get("LOCALAPPDATA") || "";
const layoutsDir = `${localAppData}\\Programs\\LyX 2.5\\Resources\\layouts`;

Deno.test("Schema parsing for book class", async () => {
  // Only run this test if the LyX directory exists locally
  try {
    const stat = await Deno.stat(layoutsDir);
    if (!stat.isDirectory) {
      console.log(`Skipping test: LyX layouts directory not found at ${layoutsDir}`);
      return;
    }
  } catch (_e) {
    console.log(`Skipping test: LyX layouts directory not found at ${layoutsDir}`);
    return;
  }

  const schema = await getSchemaForClass("book", layoutsDir);
  
  assertEquals(schema.textclass, "book");
  assert(schema.documentLayouts.length > 0, "Should have parsed document layouts");
  assert(schema.documentLayouts.includes("Chapter"), "Book class should include Chapter layout");
  
  // Verify static global constructs are present
  assert(schema.insetLayouts.includes("Plain Layout"));
  assert(schema.insets.includes("Formula"));
  assert(schema.inlineProperties.includes("change_inserted"));
});
