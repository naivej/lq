import { assertEquals, assertStringIncludes } from "@std/assert";
import * as path from "@std/path";
import { parse } from "../src/parser.ts";
import { BlockNode, TextNode } from "../src/ast.ts";

const FIXTURE_DIR = "tests/fixtures";

// Helper to create a temporary copy of a template for testing mutations
async function createTempFile(name: string): Promise<string> {
  const sourcePath = path.join(FIXTURE_DIR, "my_template.lyx");
  const tempPath = path.join(FIXTURE_DIR, name);
  await Deno.copyFile(sourcePath, tempPath);
  return tempPath;
}

// Define a type for the expected JSON response
export interface CliResult {
  status: "success" | "error";
  code?: string;
  message?: string;
  inserted_nodes?: number;
  data?: unknown[]; // Changed from any to unknown[]
}

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

Deno.test("Mutation Engine - Insert Auto-Spacer", async () => {
  const tempFile = await createTempFile("temp_spacer_test.lyx");
  try {
    // Insert a new layout after Title
    const result = await runCliTest(["insert", tempFile, "layout[Title]", "after", "--layout", "Standard", "--text", "Test Insert"]);
    assertEquals(result.status, "success");
    assertEquals(result.inserted_nodes, 1);

    // Read the file and parse it to verify
    const text = await Deno.readTextFile(tempFile);
    const ast = parse(text);
    
    // Check that we have a spacer (empty text node) between the layouts
    // In my_template.lyx, Title is followed by Author. 
    // Now it should be Title -> spacer -> Standard -> spacer -> Author
    const doc = ast.children.find(c => c.type === 'block' && c.tag === 'document') as BlockNode;
    const body = doc.children.find(c => c.type === 'block' && c.tag === 'body') as BlockNode;
    
    let titleIndex = -1;
    for (let i = 0; i < body.children.length; i++) {
      const c = body.children[i];
      if (c.type === "block" && c.tag === "layout" && c.args === "Title") {
        titleIndex = i;
        break;
      }
    }
    
    // Check the structure after Title
    const nextNode = body.children[titleIndex + 1];
    const insertedLayout = body.children[titleIndex + 2];
    const nextSpacer = body.children[titleIndex + 3];
    
    assertEquals(nextNode.type, "text");
    assertEquals((nextNode as TextNode).text, "");
    
    assertEquals(insertedLayout.type, "block");
    assertEquals((insertedLayout as BlockNode).tag, "layout");
    assertEquals((insertedLayout as BlockNode).args, "Standard");
    
    assertEquals(nextSpacer.type, "text");
    assertEquals((nextSpacer as TextNode).text, "");
    
    // Ensure it serializes with the empty line
    assertStringIncludes(text, "\\end_layout\n\n\\begin_layout Standard\nTest Insert\n\\end_layout\n\n\\begin_layout Author");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("Mutation Engine - Reject Inset in Document Body", async () => {
  const tempFile = await createTempFile("temp_inset_test.lyx");
  try {
    // Attempt to insert an inset directly into the body (e.g. after Title)
    const result = await runCliTest(["insert", tempFile, "layout[Title]", "after", "--raw", "\\begin_inset Formula\nE=mc^2\n\\end_inset"]);
    assertEquals(result.status, "error");
    assertEquals(result.code, "INVALID_CONTEXT");
    assertStringIncludes(result.message!, "Cannot insert inset directly into the document body");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("Mutation Engine - Reject Invalid Raw Strings", async () => {
  const tempFile = await createTempFile("temp_raw_test.lyx");
  try {
    // Attempt to insert plain text using --raw
    const result = await runCliTest(["insert", tempFile, "layout[Title]", "after", "--raw", "Just plain text"]);
    assertEquals(result.status, "error");
    assertEquals(result.code, "INVALID_RAW");
    assertStringIncludes(result.message!, "did not parse into any valid LyX blocks or properties");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("Mutation Engine - Guard Core Document Nodes", async () => {
  const tempFile = await createTempFile("temp_guard_test.lyx");
  try {
    // Attempt to delete body
    const deleteResult = await runCliTest(["delete", tempFile, "body"]);
    assertEquals(deleteResult.status, "error");
    assertEquals(deleteResult.code, "INVALID_CONTEXT");
    
    // Attempt to set document
    const setResult = await runCliTest(["set", tempFile, "document", "foo"]);
    assertEquals(setResult.status, "error");
    assertEquals(setResult.code, "INVALID_CONTEXT");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("Mutation Engine - Reject Empty Layout Insert", async () => {
  const tempFile = await createTempFile("temp_empty_test.lyx");
  try {
    // Attempt to insert layout without text
    let result = await runCliTest(["insert", tempFile, "layout[Title]", "after", "--layout", "Standard"]);
    assertEquals(result.status, "error");
    assertEquals(result.code, "MISSING_ARGS");

    // Attempt to insert layout with whitespace-only text
    result = await runCliTest(["insert", tempFile, "layout[Title]", "after", "--layout", "Standard", "--text", "   "]);
    assertEquals(result.status, "error");
    assertEquals(result.code, "MISSING_ARGS");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("Mutation Engine - Reject Unrecognized Layout Name", async () => {
  const tempFile = await createTempFile("temp_bad_layout_test.lyx");
  try {
    const result = await runCliTest(["insert", tempFile, "layout[Title]", "after", "--layout", "NonExistentLayout", "--text", "Foo"]);
    assertEquals(result.status, "error");
    assertEquals(result.code, "INVALID_LAYOUT");
    assertStringIncludes(result.message!, "NonExistentLayout");
  } finally {
    await Deno.remove(tempFile);
  }
});

Deno.test("Bib Engine - Extract Citations", async () => {
  const result = await runCliTest(["bib", path.join("tests", "fixtures", "my_template.lyx")]);
  assertEquals(result.status, "success");
  assertEquals(result.data!.length, 15);
  const firstCit = result.data![0] as { key: string, year: string };
  assertEquals(firstCit.key, "Mena2000");
  assertEquals(firstCit.year, "2000");
});
