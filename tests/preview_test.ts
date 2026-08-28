/**
 * Live projection contract, renderer, escaping, and semantic comparison
 * (dev log 129).
 *
 * Real-document renderer checks use my_template.lyx and Help/.
 * fixtures/Synthetic/ holds tiny hand-written isolates (hostile, oracle, CRLF).
 */
import { assert, assertEquals, assertMatch, assertStringIncludes, assertThrows } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { parse } from "../src/parser.ts";
import { hashText } from "../src/cache.ts";
import type { Node } from "../src/ast.ts";
import { query } from "../src/query.ts";
import { concatenateTextNodes } from "../src/text_utils.ts";
import { extractAllText } from "../src/tracked_changes.ts";
import {
  LIVE_CAPABILITIES,
  LIVE_CONTRACT,
  LIVE_DEFERRED_FIELDS,
  type LiveNavigate,
  type LiveToken,
  buildLiveResponse,
  detectLineEnding,
  escapeLiveHtml,
  findMagick,
  formatSem,
  normalizeReaderHtml,
  renderLiveHtml,
  semanticEqual,
  validateLiveResponse,
} from "../src/preview.ts";
import { findLayoutFile, resolveLayoutSearchPaths } from "../src/schema.ts";
import { runCliRaw, runCliTest } from "./helpers.ts";

const SYNTHETIC = fromFileUrl(new URL("./fixtures/Synthetic/", import.meta.url));
const FIXTURES = fromFileUrl(new URL("./fixtures/", import.meta.url));
const HELP_DIR = fromFileUrl(new URL("./fixtures/Help/", import.meta.url));

function syntheticPath(name: string): string {
  return `${SYNTHETIC}${name}`;
}

/** True when `{textclass}.layout` is on the default LyX search path. */
async function hasTextclassLayout(textclass: string): Promise<boolean> {
  try {
    const { searchPaths } = await resolveLayoutSearchPaths({});
    return (await findLayoutFile(`${textclass}.layout`, searchPaths)) !== undefined;
  } catch {
    return false;
  }
}

async function listHelpLyx(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(HELP_DIR)) {
    if (entry.isFile && entry.name.endsWith(".lyx")) names.push(entry.name);
  }
  names.sort();
  if (names.length === 0) throw new Error("no Help/*.lyx fixtures found");
  return names;
}

async function renderFile(name: string) {
  const filePath = syntheticPath(name);
  const text = await Deno.readTextFile(filePath);
  const ast = parse(text);
  return { filePath, text, ast, ...await renderLiveHtml(ast, { filePath }) };
}

Deno.test("Live contract - valid response is accepted", async () => {
  const text = await Deno.readTextFile(syntheticPath("headings_paragraphs.lyx"));
  const ast = parse(text);
  const { response, warnings } = await buildLiveResponse(syntheticPath("headings_paragraphs.lyx"), ast, text);
  const validated = validateLiveResponse({ ...response, warnings });
  assertEquals(validated.contract, LIVE_CONTRACT);
  assertEquals(validated.projection, "live");
  assertEquals(validated.capabilities, { ...LIVE_CAPABILITIES });
  assertEquals(validated.capabilities.outline, true);
  assert(Array.isArray(validated.outline));
  assert(validated.outline.length >= 2, "headings_paragraphs should yield outline entries");
  assertEquals(validated.source.fresh, true);
  assertEquals(validated.source.hashAlgorithm, "sha256");
  assertEquals(validated.source.hashInput, "raw-file-bytes");
  assertEquals(validated.source.diskHash.length, 64);
});

function emptyNavigate(): LiveNavigate {
  return {
    figures: [],
    tables: [],
    equations: [],
    labels: [],
    listings: [],
    algorithms: [],
  };
}

Deno.test("Live contract - rejects malformed required fields", () => {
  const base = {
    contract: LIVE_CONTRACT,
    projection: "live",
    html: "<article></article>",
    source: {
      path: "C:/tmp/a.lyx",
      hashAlgorithm: "sha256",
      hashInput: "raw-file-bytes",
      diskHash: "a".repeat(64),
      lineEnding: "lf",
      lineCount: 2,
      fresh: true,
    },
    capabilities: { ...LIVE_CAPABILITIES },
    diagnostics: [],
    outline: [],
    navigate: emptyNavigate(),
    changes: [],
    tokens: [],
  };
  assertThrows(() => validateLiveResponse({ ...base, contract: "nope" }), Error, "contract");
  assertThrows(() => validateLiveResponse({ ...base, projection: "review" }), Error, "projection");
  assertThrows(() => validateLiveResponse({ ...base, html: 1 }), Error, "html");
  assertThrows(
    () => validateLiveResponse({ ...base, capabilities: { ...LIVE_CAPABILITIES, review: true } }),
    Error,
    "review",
  );
  assertThrows(
    () => validateLiveResponse({ ...base, source: { ...base.source, fresh: false } }),
    Error,
    "fresh",
  );
  assertThrows(() => validateLiveResponse({ ...base, outline: "nope" }), Error, "outline");
});

Deno.test("Live contract - deferred fields are rejected", () => {
  const base = {
    contract: LIVE_CONTRACT,
    projection: "live",
    html: "<article></article>",
    source: {
      path: "C:/tmp/a.lyx",
      hashAlgorithm: "sha256",
      hashInput: "raw-file-bytes",
      diskHash: "a".repeat(64),
      lineEnding: "lf",
      lineCount: 2,
      fresh: true,
    },
    capabilities: { ...LIVE_CAPABILITIES },
    diagnostics: [],
    outline: [],
    navigate: emptyNavigate(),
    changes: [],
    tokens: [],
  };
  for (const field of LIVE_DEFERRED_FIELDS) {
    assertThrows(() => validateLiveResponse({ ...base, [field]: [] }), Error, field);
  }
  // outline, changes, and tokens are no longer deferred — must be accepted.
  validateLiveResponse(base);
  validateLiveResponse({
    ...base,
    changes: [
      {
        ordinal: 1,
        type: "inserted",
        author: "Alice",
        ts: "1720000000",
        anchorId: "change-1",
        snippet: "added",
      },
    ],
  });
  validateLiveResponse({
    ...base,
    tokens: [
      { id: "tok-1", bundle: { selector: "layout[Standard]:nth-match(1)" } },
    ],
  });
  const leftoverCoords = validateLiveResponse({
    ...base,
    tokens: [
      {
        id: "cell-1",
        bundle: {
          selector: "inset[Tabular]:nth-match(1) inset[Text]:nth-match(1) layout[Plain Layout]",
          coords: { row: 1, column: 2 },
        },
      },
    ],
  });
  assertEquals("coords" in leftoverCoords.tokens[0]!.bundle, false);
  assertThrows(
    () =>
      validateLiveResponse({
        ...base,
        tokens: [{ id: "", bundle: { selector: "layout[Standard]:nth-match(1)" } }],
      }),
    Error,
    "token.id",
  );
  assertThrows(
    () =>
      validateLiveResponse({
        ...base,
        tokens: [
          { id: "tok-1", bundle: { selector: "layout[Standard]:nth-match(1)" } },
          { id: "tok-1", bundle: { selector: "layout[Section]:nth-match(1)" } },
        ],
      }),
    Error,
    "unique",
  );
});

Deno.test("Live contract - CLI envelope distinguishes disk identity", async () => {
  const result = await runCliTest(["preview", syntheticPath("headings_paragraphs.lyx")]);
  const validated = validateLiveResponse(result);
  assertEquals(validated.source.fresh, true);
  assertEquals(validated.source.lineEnding, detectLineEnding(await Deno.readTextFile(syntheticPath("headings_paragraphs.lyx"))));
  assert(validated.source.lineCount > 1);
  assertEquals(validated.capabilities.editing, false);
  assertEquals(validated.capabilities.mapping, true);
  assertEquals(validated.capabilities.outline, true);
  assertEquals(validated.capabilities.sourceReveal, false);
  assert(validated.outline.some((e) => e.text.includes("Introduction")));
});

function stripMappingAttrs(html: string): string {
  return html
    .replace(/\s+data-ref="[^"]*"/g, "")
    .replace(/\s+id="tok-\d+"/g, "");
}

/** Innermost data-ref ancestor of a phrase in Live HTML (webview closest("[data-ref]")). */
function closestDataRef(html: string, phrase: string): string {
  assert(html.includes(phrase), `phrase not in Live HTML: ${JSON.stringify(phrase)}`);
  type El = { tag: string; id?: string; parent?: El };
  const root: El = { tag: "root" };
  const stack: El[] = [root];
  const re = /<([a-zA-Z0-9]+)([^>]*)\/?>|<\/([a-zA-Z0-9]+)>|([^<]+)/g;
  const VOID = new Set(["br", "img", "hr"]);
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[1]) {
      const tag = m[1].toLowerCase();
      const attrs = m[2] ?? "";
      const id = attrs.match(/\bdata-ref="([^"]*)"/)?.[1];
      const el: El = { tag, id, parent: stack[stack.length - 1] };
      if (!/\/\s*$/.test(attrs) && !VOID.has(tag)) stack.push(el);
    } else if (m[3]) {
      const want = m[3].toLowerCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === want) {
          stack.length = i;
          break;
        }
      }
    } else if (m[4]?.includes(phrase)) {
      let cur: El | undefined = stack[stack.length - 1];
      while (cur) {
        if (cur.id) return cur.id;
        cur = cur.parent;
      }
    }
  }
  throw new Error(`no data-ref ancestor for ${JSON.stringify(phrase)}`);
}

function nodeHasPhrase(node: Node, phrase: string): boolean {
  if (node.type !== "block") return false;
  const { fullText } = concatenateTextNodes(node.children, {
    includeDeleted: true,
    recurseLayouts: true,
    topLevelIsLayout: node.tag === "layout",
    skipInvisibleNotes: false,
  });
  return fullText.includes(phrase);
}

function assertPhraseMapsToQuery(
  html: string,
  tokens: LiveToken[],
  ast: ReturnType<typeof parse>,
  phrase: string,
): string {
  const id = closestDataRef(html, phrase);
  const token = tokens.find((t) => t.id === id);
  assert(token, `no token for data-ref ${id} (phrase ${JSON.stringify(phrase)})`);
  const matches = query(ast, token.bundle.selector);
  assert(
    matches.some((n) => nodeHasPhrase(n, phrase)),
    `selector ${JSON.stringify(token.bundle.selector)} from ${id} does not contain ${JSON.stringify(phrase)}`,
  );
  return token.bundle.selector;
}

/** J1 B: Tabular → that table's Text cell → layout. Not a bare Tabular inset. */
function isTableCellLayoutSelector(sel: string): boolean {
  return /inset\[Tabular/.test(sel) && /inset\[Text\]/.test(sel) && /layout\[/.test(sel);
}

/** J1 B: Float/Wrap/Listings → Caption → layout. Not a bare float/wrap/listings chip. */
function isCaptionLayoutSelector(sel: string): boolean {
  return /inset\[(?:Float|Wrap|listings)\b/.test(sel) && /inset\[Caption/.test(sel) &&
    /layout\[/.test(sel);
}

Deno.test("Live mapping - headings_paragraphs tokens match HTML ids (DL134)", async () => {
  const file = syntheticPath("headings_paragraphs.lyx");
  const text = await Deno.readTextFile(file);
  const { response } = await buildLiveResponse(file, parse(text), text);
  const validated = validateLiveResponse(response);
  assertEquals(validated.capabilities.mapping, true);
  assert(validated.tokens.length >= 4, "section + paragraphs should yield tokens");
  const ids = new Set(validated.tokens.map((t) => t.id));
  assertEquals(ids.size, validated.tokens.length, "token ids are unique");
  for (const token of validated.tokens) {
    assertStringIncludes(response.html, `id="${token.id}"`);
    assertStringIncludes(response.html, `data-ref="${token.id}"`);
    assert(token.bundle.selector.length > 0);
  }
  const section = validated.tokens.find((t) => t.bundle.selector.startsWith("layout[Section]"));
  assert(section, "Section heading is mapped");
  const standard = validated.tokens.filter((t) => t.bundle.selector.startsWith("layout[Standard]"));
  assert(standard.length >= 2, "Standard paragraphs are mapped");
  assertEquals(standard[0]?.bundle.selector, "layout[Standard]:nth-match(1)");
});

Deno.test("Live mapping - heading data-ref is on the heading tag not section (DL140)", async () => {
  const file = syntheticPath("headings_paragraphs.lyx");
  const text = await Deno.readTextFile(file);
  const ast = parse(text);
  const { response } = await buildLiveResponse(file, ast, text);
  const validated = validateLiveResponse(response);
  assertEquals(
    [...response.html.matchAll(/<section\b[^>]*\bdata-ref="/g)].length,
    0,
    "<section> must not carry data-ref (J1 A)",
  );
  assert(
    /<h[1-4]\b[^>]*\bdata-ref="/.test(response.html),
    "heading tag must carry data-ref",
  );
  // Heading words still publish a heading layout selector.
  const headingSel = assertPhraseMapsToQuery(response.html, validated.tokens, ast, "Introduction");
  assertMatch(headingSel, /^layout\[Section\]/);
  // Mapped body still wins closest (unchanged).
  const bodySel = assertPhraseMapsToQuery(response.html, validated.tokens, ast, "Café naïve");
  assertMatch(bodySel, /^layout\[Standard\]/);
});

Deno.test("Live mapping - Description dd values publish the layout path (DL141)", async () => {
  const file = fromFileUrl(new URL("./fixtures/Help/EmbeddedObjects.lyx", import.meta.url));
  const text = await Deno.readTextFile(file);
  const ast = parse(text);
  const { response } = await buildLiveResponse(file, ast, text);
  const validated = validateLiveResponse(response);
  const phrase = "Here you can choose an image";
  const sel = assertPhraseMapsToQuery(response.html, validated.tokens, ast, phrase);
  assertMatch(sel, /^layout\[Description\]/);
  assert(
    !/layout\[(Chapter|Section|Subsection|Subsubsection)/.test(sel),
    `dd must not steal heading: ${sel}`,
  );
  assert(
    query(ast, sel).some((n) => extractAllText(n).includes(phrase)),
    `--text-only of ${sel} should contain ${JSON.stringify(phrase)}`,
  );
});

Deno.test("Live mapping - title Foot and Box inners are nested layouts (DL144 F1)", async () => {
  const file = fromFileUrl(new URL("./fixtures/my_template.lyx", import.meta.url));
  const text = await Deno.readTextFile(file);
  const ast = parse(text);
  const { response } = await buildLiveResponse(file, ast, text);
  const validated = validateLiveResponse(response);
  const footSel = assertPhraseMapsToQuery(response.html, validated.tokens, ast, "Details about me");
  assertMatch(footSel, /inset\[Foot/);
  assertMatch(footSel, /layout\[/);
  assert(!/^inset\[Foot[^\]]*\]:nth-match\(\d+\)$/.test(footSel));

  const boxFile = syntheticPath("disclosure_collapsibles.lyx");
  const boxText = await Deno.readTextFile(boxFile);
  const boxAst = parse(boxText);
  const boxLive = await buildLiveResponse(boxFile, boxAst, boxText);
  const boxVal = validateLiveResponse(boxLive.response);
  const boxSel = assertPhraseMapsToQuery(
    boxLive.response.html,
    boxVal.tokens,
    boxAst,
    "Boxed inset body",
  );
  assertMatch(boxSel, /inset\[Box/);
  assertMatch(boxSel, /layout\[/);
});

Deno.test("Live mapping - Flex Code uses enclosing layout prefix (DL144 F2)", async () => {
  const file = fromFileUrl(new URL("./fixtures/Help/Customization.lyx", import.meta.url));
  const text = await Deno.readTextFile(file);
  const ast = parse(text);
  const { response } = await buildLiveResponse(file, ast, text);
  const validated = validateLiveResponse(response);
  // Unique inside Customization Live HTML (avoids TOC / repeated LyXDir).
  const phrase = "lyxrc.defaults";
  assertStringIncludes(response.html, phrase);
  const id = closestDataRef(response.html, phrase);
  const token = validated.tokens.find((t) => t.id === id);
  assert(token, `no token for ${id}`);
  const sel = token.bundle.selector;
  assertMatch(sel, /inset\[Flex Code/);
  assertMatch(sel, /layout\[/);
  assertMatch(sel, /^layout\[/); // J3 B: enclosing layout first
  assert(
    query(ast, sel).some((n) => extractAllText(n).includes(phrase)),
    `--text-only of ${sel} should contain ${JSON.stringify(phrase)}`,
  );
});

Deno.test("Live mapping - listings code lines are nested layouts (DL144 F3)", async () => {
  const file = fromFileUrl(new URL("./fixtures/Help/Development.lyx", import.meta.url));
  const text = await Deno.readTextFile(file);
  const ast = parse(text);
  const { response } = await buildLiveResponse(file, ast, text);
  const validated = validateLiveResponse(response);
  const phrase = "++T;";
  assertStringIncludes(response.html, phrase);
  const sel = assertPhraseMapsToQuery(response.html, validated.tokens, ast, phrase);
  assertMatch(sel, /inset\[listings/i);
  assertMatch(sel, /layout\[/);
  assert(!/^layout\[Standard\]/.test(sel), `listings must not stay on Standard: ${sel}`);
});

Deno.test("Live mapping - Formula/Graphics/ref tokens are object insets (DL144 F4)", async () => {
  const file = fromFileUrl(new URL("./fixtures/my_template.lyx", import.meta.url));
  const text = await Deno.readTextFile(file);
  const ast = parse(text);
  const { response } = await buildLiveResponse(file, ast, text);
  const validated = validateLiveResponse(response);
  const formula = validated.tokens.find((t) => /^inset\[Formula/.test(t.bundle.selector));
  assert(formula, "expected a Formula mapping token");
  assertMatch(formula.bundle.selector, /^inset\[Formula\]:nth-match\(\d+\)$/);
  assert(
    !formula.bundle.selector.includes("$"),
    `Formula selector must not embed TeX: ${formula.bundle.selector}`,
  );
  assertEquals(query(ast, formula.bundle.selector).length >= 1, true);
  const graphics = validated.tokens.find((t) => /inset\[Graphics\]/.test(t.bundle.selector));
  assert(graphics, "expected a Graphics mapping token");
  assertMatch(graphics.bundle.selector, /inset\[(Float|Wrap|Graphics)/);
  const ref = validated.tokens.find((t) => /CommandInset ref/.test(t.bundle.selector));
  assert(ref, "expected a CommandInset ref mapping token");
  const cite = validated.tokens.find((t) => /CommandInset citation/.test(t.bundle.selector));
  assert(cite, "expected a CommandInset citation mapping token");
});

Deno.test("Live mapping - LyX-Code lines publish layout paths (DL143)", async () => {
  const file = fromFileUrl(new URL("./fixtures/Help/Additional.lyx", import.meta.url));
  const text = await Deno.readTextFile(file);
  const ast = parse(text);
  const { response } = await buildLiveResponse(file, ast, text);
  const validated = validateLiveResponse(response);
  // Live HTML shows "\usepackage…"; CST stores a backslash property + "usepackage…".
  const phrase = "\\usepackage{indentfirst}";
  assertStringIncludes(response.html, phrase);
  const id = closestDataRef(response.html, phrase);
  const token = validated.tokens.find((t) => t.id === id);
  assert(token, `no token for data-ref ${id}`);
  const sel = token.bundle.selector;
  assertMatch(sel, /^layout\[LyX-Code\]/);
  assert(
    !/layout\[(Chapter|Section|Subsection|Subsubsection)/.test(sel),
    `LyX-Code must not steal heading: ${sel}`,
  );
  const matches = query(ast, sel);
  assertEquals(matches.length >= 1, true);
  assert(
    matches.some((n) => extractAllText(n).includes("usepackage{indentfirst}")),
    `--text-only of ${sel} should contain usepackage{indentfirst}`,
  );
  // J1 B: consecutive LyX-Code layouts in one <pre> get distinct token selectors.
  const preBlock = [...response.html.matchAll(/<pre class="lyx_code">([\s\S]*?)<\/pre>/g)]
    .map((m) => m[1])
    .find((body) => (body.match(/data-ref="/g) ?? []).length >= 2);
  if (preBlock) {
    const ids = [...preBlock.matchAll(/data-ref="([^"]+)"/g)].map((m) => m[1]);
    const sels = ids.map((id) => validated.tokens.find((t) => t.id === id)?.bundle.selector);
    assertEquals(new Set(sels).size >= 2, true, "multi-layout lyx_code run needs distinct selectors");
  }
});

Deno.test("Live mapping - longtable Caption is owner-prefixed (DL142)", async () => {
  const file = fromFileUrl(new URL("./fixtures/Help/EmbeddedObjects.lyx", import.meta.url));
  const text = await Deno.readTextFile(file);
  const ast = parse(text);
  const { response } = await buildLiveResponse(file, ast, text);
  const validated = validateLiveResponse(response);
  const phrase = "Multi-page table with caption";
  const sel = assertPhraseMapsToQuery(response.html, validated.tokens, ast, phrase);
  assertMatch(sel, /inset\[Tabular/);
  assertMatch(sel, /inset\[Caption/);
  assertMatch(sel, /layout\[/);
  assert(
    !/^inset\[Caption/.test(sel),
    `Caption must not stay document-global: ${sel}`,
  );
  assert(
    query(ast, sel).some((n) => extractAllText(n).includes(phrase)),
    `--text-only of ${sel} should contain ${JSON.stringify(phrase)}`,
  );
});

Deno.test("Live mapping - table cells publish nested layout paths (DL138)", async () => {
  const file = syntheticPath("table_figure_foot_math.lyx");
  const text = await Deno.readTextFile(file);
  const ast = parse(text);
  const { response } = await buildLiveResponse(file, ast, text);
  const validated = validateLiveResponse(response);
  assertEquals(validated.tokens.filter((t) => "coords" in t.bundle).length, 0);
  const tds = [...response.html.matchAll(/<td\b([^>]*)>/g)];
  assert(tds.length >= 4, "2x2 table should emit four cells");
  for (const td of tds) {
    assert(/\bdata-ref="/.test(td[1]), "every <td> stays mapped (J2 B padding/empty)");
  }
  const expected: Record<string, string> = {
    A: "inset[Tabular]:nth-match(1) inset[Text]:nth-match(1) layout[Plain Layout]",
    B: "inset[Tabular]:nth-match(1) inset[Text]:nth-match(2) layout[Plain Layout]",
    C: "inset[Tabular]:nth-match(1) inset[Text]:nth-match(3) layout[Plain Layout]",
    D: "inset[Tabular]:nth-match(1) inset[Text]:nth-match(4) layout[Plain Layout]",
  };
  for (const [letter, want] of Object.entries(expected)) {
    const sel = assertPhraseMapsToQuery(response.html, validated.tokens, ast, letter);
    assertEquals(sel, want);
    assert(isTableCellLayoutSelector(sel));
    assert(!/^inset\[Tabular\]:nth-match\(\d+\)$/.test(sel));
    const matches = query(ast, sel);
    assertEquals(matches.length, 1, `unique cell ${letter} should query to one node`);
    assert(
      matches.some((n) => extractAllText(n).includes(letter)),
      `--text-only of ${sel} should contain ${letter}`,
    );
  }
});

Deno.test("Live mapping - Intro table phrase is a cell layout (DL138)", async () => {
  const file = fromFileUrl(new URL("./fixtures/Help/Intro.lyx", import.meta.url));
  const text = await Deno.readTextFile(file);
  const ast = parse(text);
  const { response } = await buildLiveResponse(file, ast, text);
  const validated = validateLiveResponse(response);
  const phrase = "name/description";
  const sel = assertPhraseMapsToQuery(response.html, validated.tokens, ast, phrase);
  assert(isTableCellLayoutSelector(sel), `expected nested cell layout, got ${sel}`);
  assert(!/^inset\[Tabular\]:nth-match\(\d+\)$/.test(sel));
  const token = validated.tokens.find((t) => t.bundle.selector === sel);
  assert(token);
  assertEquals("coords" in token.bundle, false);
  const matches = query(ast, sel);
  assert(
    matches.some((n) => extractAllText(n).includes(phrase)),
    `--text-only of ${sel} should contain ${JSON.stringify(phrase)}`,
  );
});

Deno.test("Live mapping - float caption words publish Caption layout path (DL139)", async () => {
  const file = syntheticPath("table_figure_foot_math.lyx");
  const text = await Deno.readTextFile(file);
  const ast = parse(text);
  const { response } = await buildLiveResponse(file, ast, text);
  const validated = validateLiveResponse(response);
  const phrase = "A figure caption.";
  const sel = assertPhraseMapsToQuery(response.html, validated.tokens, ast, phrase);
  assert(isCaptionLayoutSelector(sel), `expected Float→Caption→layout, got ${sel}`);
  assert(!/^inset\[Float [^\]]+\]:nth-match\(\d+\)$/.test(sel), `caption words must not stay on chip: ${sel}`);
  assertEquals(
    sel,
    "inset[Float figure]:nth-match(1) inset[Caption Standard] layout[Plain Layout]",
  );
  const matches = query(ast, sel);
  assertEquals(matches.length, 1);
  assert(
    matches.some((n) => extractAllText(n).includes(phrase)),
    `--text-only of ${sel} should contain ${JSON.stringify(phrase)}`,
  );
  const chip = validated.tokens.find((t) =>
    /^inset\[Float figure\]:nth-match\(1\)$/.test(t.bundle.selector)
  );
  assert(chip, "float chip token must remain (J2 B)");
});

Deno.test("Live mapping - EmbeddedObjects float caption is editable (DL139)", async () => {
  const file = fromFileUrl(new URL("./fixtures/Help/EmbeddedObjects.lyx", import.meta.url));
  const text = await Deno.readTextFile(file);
  const ast = parse(text);
  const { response } = await buildLiveResponse(file, ast, text);
  const validated = validateLiveResponse(response);
  const phrase = "A star in a float.";
  const sel = assertPhraseMapsToQuery(response.html, validated.tokens, ast, phrase);
  assert(isCaptionLayoutSelector(sel), `expected Float→Caption→layout, got ${sel}`);
  assert(!/^inset\[Float [^\]]+\]:nth-match\(\d+\)$/.test(sel));
  assert(
    query(ast, sel).some((n) => extractAllText(n).includes(phrase)),
    `--text-only of ${sel} should contain ${JSON.stringify(phrase)}`,
  );
});

Deno.test("Live mapping - review_changes.lyx emits change-N tokens (DL134)", async () => {
  const file = syntheticPath("review_changes.lyx");
  const text = await Deno.readTextFile(file);
  const { response } = await buildLiveResponse(file, parse(text), text);
  const validated = validateLiveResponse(response);
  const changeTokens = validated.tokens.filter((t) => t.id.startsWith("change-"));
  assert(changeTokens.length >= 1, "change regions should be mapped");
  for (const t of changeTokens) {
    assertStringIncludes(response.html, `id="${t.id}"`);
    assert(t.bundle.selector.includes("layout[") || t.bundle.selector.includes("inset["));
  }
  assert(validated.changes.every((c) => changeTokens.some((t) => t.id === c.anchorId)));
});

Deno.test("Live mapping - my_template footnote/note phrases round-trip via query (DL135)", async () => {
  const file = `${FIXTURES}my_template.lyx`;
  const text = await Deno.readTextFile(file);
  const ast = parse(text);
  const { response } = await buildLiveResponse(file, ast, text);
  const validated = validateLiveResponse(response);
  const foot = assertPhraseMapsToQuery(response.html, validated.tokens, ast, "A footnote.");
  assert(
    foot.includes("inset[Foot]") && foot.includes("layout[Plain Layout]"),
    `body footnote inner should be a nested path, got ${foot}`,
  );
  assertPhraseMapsToQuery(response.html, validated.tokens, ast, "I like to use lyx note");
  assertPhraseMapsToQuery(response.html, validated.tokens, ast, "Details about me");
});

Deno.test("Live mapping - included child .lyx tokens point at child file (DL136)", async () => {
  const master = fromFileUrl(new URL("./fixtures/Help/EmbeddedObjects.lyx", import.meta.url));
  const text = await Deno.readTextFile(master);
  const ast = parse(text);
  const { response } = await buildLiveResponse(master, ast, text);
  const validated = validateLiveResponse(response);
  assertEquals(
    validated.tokens.filter((t) => /CommandInset include.*layout\[/.test(t.bundle.selector)).length,
    0,
    "must not nest child layouts under Include",
  );
  const phrase = "This is a small dummy child document";
  const id = closestDataRef(response.html, phrase);
  const token = validated.tokens.find((t) => t.id === id);
  assert(token, `token for ${id}`);
  assert(token.bundle.file, "foreign file set");
  assert(token.bundle.file.replaceAll("\\", "/").endsWith("/DummyDocument1.lyx"));
  assert(token.bundle.diskHash && token.bundle.diskHash.length === 64);
  assert(token.bundle.via, "via provenance set");
  assertEquals(token.bundle.via!.selector, "inset[CommandInset include]:nth-match(1)");
  assert(token.bundle.via!.file.replaceAll("\\", "/").endsWith("/EmbeddedObjects.lyx"));
  const childAst = parse(await Deno.readTextFile(token.bundle.file!));
  const matches = query(childAst, token.bundle.selector);
  assert(matches.some((n) => nodeHasPhrase(n, phrase)), "child query owns phrase");
  const viaHits = query(ast, token.bundle.via!.selector);
  assertEquals(viaHits.length, 1);
  assert(viaHits[0]?.type === "block" && (viaHits[0].args ?? "").startsWith("CommandInset include"));
});

Deno.test("Live mapping - footnote phrases round-trip on synthetic insets (DL135)", async () => {
  for (
    const [name, phrases] of [
      ["disclosure_notes.lyx", ["Selectable footnote body.", "private note body"]],
      ["table_figure_foot_math.lyx", ["Footnote body."]],
      ["disclosure_collapsibles.lyx", [
        "Author footnote body (click the star).",
        "Body footnote content.",
      ]],
    ] as const
  ) {
    const file = syntheticPath(name);
    const text = await Deno.readTextFile(file);
    const ast = parse(text);
    const { response } = await buildLiveResponse(file, ast, text);
    const validated = validateLiveResponse(response);
    for (const phrase of phrases) {
      assertPhraseMapsToQuery(response.html, validated.tokens, ast, phrase);
    }
  }
});

Deno.test("Live mapping - no-change HTML is additive-only (DL134)", async () => {
  const file = syntheticPath("headings_paragraphs.lyx");
  const text = await Deno.readTextFile(file);
  const { response } = await buildLiveResponse(file, parse(text), text);
  const stripped = stripMappingAttrs(response.html);
  assert(!/data-ref=/.test(stripped));
  assertEquals(stripped.includes("<section"), true);
  assertEquals(stripped.includes("<h1") || stripped.includes("<h2") || stripped.includes("<section"), true);
});

Deno.test("Live contract - buildLiveResponse honors the passed diskHash (DL132 P4)", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".lyx" });
  try {
    const original = await Deno.readTextFile(syntheticPath("headings_paragraphs.lyx"));
    await Deno.writeTextFile(tmp, original);
    const ast = parse(original);
    const expected = await hashText(original);
    // Simulate a mid-run disk change: the response must identify the bytes it
    // rendered (the passed hash), not the newer disk state.
    await Deno.writeTextFile(tmp, original + "\n% changed on disk after read\n");
    const { response } = await buildLiveResponse(tmp, ast, original, {}, expected);
    assertEquals(response.source.diskHash, expected);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("Live navigate - Labels lists only leftover anchors (DL131 B)", async () => {
  const file = syntheticPath("navigate_labels.lyx");
  const text = await Deno.readTextFile(file);
  const { response } = await buildLiveResponse(file, parse(text), text);
  const validated = validateLiveResponse(response);
  const names = validated.navigate.labels.map((l) => l.name).sort();
  assertEquals(names, ["box:aside-point", "note:custom-hook"]);
  // Covered elsewhere — must not reappear under Labels.
  for (const banned of ["sec:intro", "fig:demo", "eq:demo"]) {
    assert(!names.includes(banned), `${banned} must not appear under Labels`);
  }
  // Leftovers must not inherit enclosing section number/title (that hid them in Explorer dedupe).
  for (const l of validated.navigate.labels) {
    assertEquals(l.number, "");
    assertEquals(l.text, "");
    assert(!!l.name);
    assertStringIncludes(response.html, `id="${l.id}"`);
  }
  assert(validated.outline.some((e) => /Introduction/i.test(e.text)));
  assert(validated.navigate.figures.some((e) => e.id.includes("float-figure")));
  assert(validated.navigate.equations.some((e) => e.name === "eq:demo" || e.id.includes("eq")));
});

Deno.test("Live outline - disclosure_collapsibles reuses TOC heading ids (DL131 B1)", async () => {
  const { response } = await buildLiveResponse(
    syntheticPath("disclosure_collapsibles.lyx"),
    parse(await Deno.readTextFile(syntheticPath("disclosure_collapsibles.lyx"))),
    await Deno.readTextFile(syntheticPath("disclosure_collapsibles.lyx")),
  );
  const validated = validateLiveResponse(response);
  assert(validated.outline.length >= 5);
  for (const e of validated.outline) {
    assert(e.id.length > 0);
    assertStringIncludes(response.html, `id="${e.id}"`);
  }
  assert(validated.outline.some((e) => /Body footnotes/i.test(e.text)));
  assert(Array.isArray(validated.navigate.figures));
  assert(Array.isArray(validated.navigate.tables));
  assert(validated.navigate.figures.length >= 1, "disclosure fixture has a figure float");
  assert(validated.navigate.tables.length >= 1, "disclosure fixture has a table float");
  for (const e of [...validated.navigate.figures, ...validated.navigate.tables]) {
    assertStringIncludes(response.html, `id="${e.id}"`);
  }
});

Deno.test("Live renderer - headings, paragraphs, unicode, empty, emphasis", async () => {
  const { html } = await renderFile("headings_paragraphs.lyx");
  const sem = normalizeReaderHtml(html);
  assertEquals(sem.role, "document");
  const dump = formatSem(sem);
  assertStringIncludes(dump, "heading");
  // DL145 J6 H: Live counter wrapped for user-select:none; title stays outside the span.
  assertMatch(
    html,
    /<h2\b[^>]*><span class="heading-number">1 <\/span>Introduction<\/h2>/,
  );
  assertMatch(
    html,
    /<h3\b[^>]*><span class="heading-number">1\.1 <\/span>Details<\/h3>/,
  );
  assertStringIncludes(html, "Café naïve");
  assertStringIncludes(html, "𝄞");
  assertStringIncludes(html, "<em>styled</em>");
  assert(!html.includes('<div class="standard"></div>'), "empty Standard paragraphs are omitted like native XHTML");
});

Deno.test("Live renderer - SpecialChar emits data-lq-text for --text-only selection (DL145)", async () => {
  const { html } = await renderFile("disclosure_collapsibles.lyx");
  assertMatch(
    html,
    /<span class="specialchar" data-lq-text="\\SpecialChar LyX">LyX<\/span>/,
  );
});

Deno.test("Live renderer - lists and quotes", async () => {
  const { html } = await renderFile("lists_quotes.lyx");
  assertStringIncludes(html, "<ul>");
  assertMatch(html, /<li\b[^>]*>outer one/);
  assertMatch(html, /<ul><li\b[^>]*>nested<\/li><\/ul>/);
  assertStringIncludes(html, '<ol class="enumi">');
  assertMatch(html, /<li\b[^>]*>first<\/li>/);
  assertMatch(html, /<dt\b[^>]*>Term<\/dt>/);
  assertMatch(html, /<dd\b[^>]*>the explanation<\/dd>/); // DL141: dd carries data-ref
  assertStringIncludes(html, '<blockquote class="quote">');
  assertStringIncludes(html, "A quoted line.");
});

Deno.test("Live renderer - missing textclass.layout is a hard error", async () => {
  const filePath = syntheticPath("headings_paragraphs.lyx");
  let caught: (Error & { code?: string }) | undefined;
  try {
    await renderLiveHtml(parse(await Deno.readTextFile(filePath)), {
      filePath,
      layoutsDir: "Z:\\lq-no-such-layouts",
    });
  } catch (e) {
    caught = e as Error & { code?: string };
  }
  assert(caught !== undefined, "expected LAYOUT_NOT_FOUND");
  assertEquals(caught!.code, "LAYOUT_NOT_FOUND");
  assertStringIncludes(caught!.message, "article");
});

Deno.test("Live renderer - table, figure, footnote, formula", async () => {
  const { html } = await renderFile("table_figure_foot_math.lyx");
  assertStringIncludes(html, "<table>");
  assertStringIncludes(html, "<td");
  assertStringIncludes(html, ">A</");
  assertStringIncludes(html, "disclose foot");
  assertStringIncludes(html, "Footnote body.");
  assertStringIncludes(html, "<math");
  assertStringIncludes(html, "E=mc^{2}");
  assertStringIncludes(html, "<figure");
  assertStringIncludes(html, 'data-filename="live-figure.png"');
  assertStringIncludes(html, "<figcaption");
  assertStringIncludes(html, "Figure 1: ");
  assertStringIncludes(html, 'class="float-caption-Standard"');
  assert(
    !/<figcaption[^>]*>(?:<span class="float-caption-prefix">)?Figure 1: (?:<\/span>)?<div/.test(html),
    "caption must stay on one line",
  );
  assertStringIncludes(html, "data-filepath=");
  assertStringIncludes(html, 'src="file:');
});

Deno.test("Live renderer - hostile strings stay escaped", async () => {
  const { html } = await renderFile("hostile.lyx");
  assert(!html.includes("<script>"), "raw script tag must not appear");
  assert(!html.includes("<img src=x"), "raw hostile img must not appear");
  assertStringIncludes(html, "&lt;script&gt;");
  assertStringIncludes(html, "&amp; ampersands");
  assertStringIncludes(html, "&quot;quotes&quot;");
});

Deno.test("Live renderer - tracked changes render as ins/del wrappers; ERT is a Live chip", async () => {
  const { html, diagnostics, changes } = await renderFile("tracked_ert_notes.lyx");
  assertStringIncludes(html, "Visible");
  assertStringIncludes(html, '<ins class="change-inserted change-author-0" id="change-1" data-ref="change-1"> inserted</ins>');
  assertStringIncludes(html, '<del class="change-deleted change-author-0" id="change-2" data-ref="change-2"> deleted</del>');
  assertEquals(changes, [
    { ordinal: 1, type: "inserted", author: "Tester", ts: "0", anchorId: "change-1", snippet: "inserted" },
    { ordinal: 2, type: "deleted", author: "Tester", ts: "0", anchorId: "change-2", snippet: "deleted" },
  ]);
  // DL131: ERT is Live-only plain-text disclosure (native XHTML still omits).
  assertStringIncludes(html, 'class="disclose ert"');
  assertStringIncludes(html, "\\textbf{nope}");
  assert(!diagnostics.some((d) => d.code === "ERT_OMITTED"), "ERT_OMITTED retired for Live chips");
});

Deno.test("Live renderer - review_changes covers index, nesting, foot chip, whole-deleted", async () => {
  const { html, changes } = await renderFile("review_changes.lyx");
  assertEquals(changes.map((c) => `${c.ordinal}:${c.type}:${c.author}:${c.ts}`), [
    "1:inserted:Alice:1724000000",
    "2:inserted:Alice:1724000000",
    "3:inserted:Bob:1724000100",
    "4:inserted:Alice:1724000200",
    "5:inserted:Alice:1724000300",
    "6:deleted:Bob:1724000400",
    "7:deleted:Shifu:1787415906",
    "8:inserted:Shifu:1787415958",
    "9:inserted:Shifu:1787415949",
    "10:inserted:Shifu:1787415961",
    "11:deleted:Alice:1724000500",
  ]);
  // Document order = wrapper open order (ordinal), even when nested wrappers
  // close after their parent (DL133 bug-batch fix).
  assertEquals(changes.map((c) => c.ordinal), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  // Adjacent same/different-author runs reopen wrappers in document order.
  assertStringIncludes(html, '<ins class="change-inserted change-author-0" id="change-2" data-ref="change-2">one</ins>');
  assertStringIncludes(html, '<ins class="change-inserted change-author-1" id="change-3" data-ref="change-3">two</ins>');
  assertStringIncludes(html, '<ins class="change-inserted change-author-0" id="change-4" data-ref="change-4">three</ins>');
  // Different authors get different color slots (Alice=0, Bob=1, Shifu=2).
  assert(html.includes("change-author-0"), "Alice's slot must be present");
  assert(html.includes("change-author-1"), "Bob's slot must be present");
  assert(html.includes("change-author-2"), "Shifu's slot must be present");
  // Emphasis crossing a change boundary nests validly (wrapper outermost).
  assertStringIncludes(
    html,
    '<em>base</em><ins class="change-inserted change-author-0" id="change-5" data-ref="change-5"><em>ins</em></ins><em>tail</em>',
  );
  // A deleted footnote is wrapped at the chip level; its body stays plain.
  assertStringIncludes(html, '<del class="change-deleted change-author-1" id="change-6" data-ref="change-6"><details class="disclose foot"');
  assertStringIncludes(html, "Deleted footnote body.");
  // Whole-inset inserted Note+Foot owner opens before its inner runs (ordinal
  // 8/9/10), so the outer wrapper stays first in document order.
  assertStringIncludes(
    html,
    '<ins class="change-inserted change-author-2" id="change-8" data-ref="change-8"><details class="disclose note note-note"',
  );
  assertStringIncludes(html, '<ins class="change-inserted change-author-2" id="change-9" data-ref="change-9">new note</ins>');
  assertStringIncludes(html, '<ins class="change-inserted change-author-2" id="change-10" data-ref="change-10">new foot</ins>');
  // LyX numbering: the deleted footnote shows its would-be number 1 without
  // consuming it, so the inserted footnote is also 1.
  assertEquals((html.match(/class="foot_label">1<\/summary>/g) ?? []).length, 2);
  assertEquals(changes[5].snippet, "[Foot]");
  assertEquals(changes[6].snippet, "[Note Note]");
  assertEquals(changes[7].snippet, "[Note Note][Foot]");
  // Whole-deleted paragraph keeps the del wrapper and marks its container.
  assertStringIncludes(
    html,
    '<div class="standard change-deleted" id="tok-13" data-ref="tok-13"><del class="change-deleted change-author-0" id="change-11" data-ref="change-11">This whole paragraph was deleted.</del></div>',
  );
  assertEquals(changes[10].snippet, "This whole paragraph was deleted.");
});

Deno.test("Live renderer - review_changes_counters skips deleted construct numbers (LyX J-C)", async () => {
  const { html, navigate } = await renderFile("review_changes_counters.lyx");
  // Footnotes: a deleted footnote shows the would-be number and does not
  // consume it; the next footnote is also 1.
  assertEquals((html.match(/class="foot_label">1<\/summary>/g) ?? []).length, 2);
  // A footnote nested inside a deleted footnote also skips (LyX propagates
  // the deleted flag), so the outer deleted foot, its nested foot, and the
  // following foot all show the same would-be number 2.
  assertEquals((html.match(/class="foot_label">2<\/summary>/g) ?? []).length, 3);
  // Floats: deleted figure/table captions keep the would-be number without
  // consuming it; the next figure/table is also numbered 1.
  // Caption words sit in a mapped <span> (DL139); prefix stays outside.
  assertMatch(html, /Figure 1: (?:<\/span>)?(?:<span[^>]*>)?Deleted figure caption/);
  assertMatch(html, /Figure 1: (?:<\/span>)?(?:<span[^>]*>)?Second figure caption/);
  assertMatch(html, /Table 1: (?:<\/span>)?(?:<span[^>]*>)?Deleted table caption/);
  assertMatch(html, /Table 1: (?:<\/span>)?(?:<span[^>]*>)?Second table caption/);
  // The deleted float with an equation shows the would-be Figure 2.
  assertMatch(html, /Figure 2: (?:<\/span>)?(?:<span[^>]*>)?Deleted float with equation/);
  // Equations: a deleted row shows # and does not consume; the next is 1.
  assertStringIncludes(html, '<span class="eqno">(#)</span>');
  assertStringIncludes(html, '<span class="eqno">(1)</span>');
  // LyX hull quirk (J-C): an equation inside a whole-deleted float still
  // consumes a number, so it is 2 and the following equation is 3.
  assertStringIncludes(html, '<span class="eqno">(2)</span>');
  assertStringIncludes(html, '<span class="eqno">(3)</span>');
  // Nav mirrors the render: deleted floats/equations are excluded, but the
  // nested equation inside the deleted float stays (its own position is not
  // deleted), and numbers match the page.
  assertEquals(
    navigate.equations.map((e) => `${e.number}:${e.text}`),
    ["1:y=2", "2:a=b", "3:c=d"],
  );
  assertEquals(navigate.figures.map((e) => e.number), ["1"]);
  assertEquals(navigate.tables.map((e) => e.number), ["1"]);
});

Deno.test("Live renderer - click disclosure and private Note/Comment (DL131)", async () => {
  const { html } = await renderFile("disclosure_notes.lyx");
  assertStringIncludes(html, "<details class=\"disclose foot\"");
  assertStringIncludes(html, "<summary class=\"foot_label\">1</summary>");
  assertStringIncludes(html, "Selectable footnote body");
  assertStringIncludes(html, 'class="disclose note note-note"');
  assertStringIncludes(html, "<summary class=\"disclose-summary\">Note</summary>");
  assertStringIncludes(html, "private note body");
  assertStringIncludes(html, 'class="disclose note note-comment"');
  assertStringIncludes(html, "<summary class=\"disclose-summary\">Comment</summary>");
  assertStringIncludes(html, "private comment body");
  assertStringIncludes(html, 'class="disclose note note-greyedout"');
  assertStringIncludes(html, "<summary class=\"disclose-summary\">Greyedout</summary>");
  assertStringIncludes(html, "greyed always visible");
  // Must not use hover-only hide (collapsed by default via <details>).
  assert(!html.includes(":hover"), "Live HTML must not embed hover CSS");
  assert(!html.includes('class="foot"><span class="foot_label">'), "legacy hover foot markup removed");
});

Deno.test("Live renderer - disclosure_collapsibles covers foldable inset set (DL131)", async () => {
  const { html } = await renderFile("disclosure_collapsibles.lyx");
  const mustDisclose = [
    'class="disclose foot foot_intitle"',
    'class="disclose foot"',
    'class="disclose note note-note"',
    'class="disclose note note-comment"',
    'class="disclose note note-greyedout"',
    'class="disclose marginal"',
    'class="disclose box boxed"',
    'class="disclose float float-figure"',
    'class="disclose float float-table"',
    'class="disclose wrap',
    'class="disclose branch"',
    'class="disclose ert"',
    'class="disclose phantom"',
    'class="disclose index-marker"',
    'class="disclose nomencl"',
    'class="disclose argument"',
    'class="disclose argument short-title"',
  ];
  for (const needle of mustDisclose) {
    assertStringIncludes(html, needle);
  }
  assertStringIncludes(html, 'style="width: 50%"');
  assert(!html.includes("box-full"), "50col% boxes must not get 100%-column chrome (DL150 J4-B)");
  assertStringIncludes(html, ">Float: Figure</summary>");
  assertStringIncludes(html, ">Float: Table</summary>");
  assertStringIncludes(html, ">Wrap: Figure</summary>");
  assertStringIncludes(html, "Greyedout stays visible");
  assertStringIncludes(html, "ShortTitle");
  assertStringIncludes(html, ">Short Title</summary>");
  assertStringIncludes(html, ">NomSymbol</summary>");
  assertStringIncludes(html, ">IndexTerm</summary>");
  assertStringIncludes(html, ">Branch: Demo</summary>");
  assertStringIncludes(html, ">Margin</summary>");
  assertStringIncludes(html, ">Box</summary>");
  assertStringIncludes(html, "\\textbf{chip}");
  assertStringIncludes(html, "phantom body");
  assertStringIncludes(html, ">Argument</summary>");
  assertStringIncludes(html, "Nom description");
  assert(!html.includes("NomSymbol — Nom description"), "Nomenclature must not flatten symbol+description into one marker body");
  assertStringIncludes(html, "IndexTerm");
  assertStringIncludes(html, "NomSymbol");
  assertStringIncludes(html, "Nom description");
  // Non-chip catalog samples present for Live vs GUI comparison.
  assertStringIncludes(html, "<math");
  assertStringIncludes(html, "<table");
  assertStringIncludes(html, "live-figure.png");
  assertStringIncludes(html, "print(&quot;hello&quot;)");
  assertStringIncludes(html, 'class="preview"');
  assert(!html.includes("preview-label"), "Preview box must not add an extra Preview label");
  assertStringIncludes(html, 'class="lyx-pagebreak"');
  assertStringIncludes(html, 'class="lyx-separator"');
  assertStringIncludes(html, 'class="lyx-vspace"');
  assertStringIncludes(html, "<sup>");
  assertStringIncludes(html, "<sub>");
  assertStringIncludes(html, 'href="https://www.lyx.org/"');
  // Charstyle Flex / URL must remain inline — not disclosure chips.
  assertStringIncludes(html, 'class="flex_code"');
  assertStringIncludes(html, 'class="flex_emph"');
  assertStringIncludes(html, 'class="flex_strong"');
  assertStringIncludes(html, 'class="noun"'); // Flex Noun → span.noun
  assertStringIncludes(html, 'class="flex_url"');
  assert(!/class="disclose[^"]*url/i.test(html), "Flex URL must stay inline, not a disclosure chip");
  const codeIdx = html.indexOf('class="flex_code"');
  assert(codeIdx !== -1);
  assert(
    !html.slice(Math.max(0, codeIdx - 80), codeIdx).includes("<details"),
    "Flex Code must not sit inside a preceding details opener",
  );
});

Deno.test("Live renderer - disclosure_collapsibles tracked whole-inset variants (DL133)", async () => {
  const { html, changes } = await renderFile("disclosure_collapsibles.lyx");
  // 16 disclosure kinds × inserted/deleted + 4 nested combos = 36 regions,
  // all from author 1 ("Tester").
  assertEquals(changes.length, 36);
  assert(changes.every((c) => c.author === "Tester"));
  // Every disclosure-chip kind appears as a whole-inset insert and delete.
  const kinds = [
    "foot",
    "note note-note",
    "note note-comment",
    "marginal",
    "box boxed",
    "float float-figure",
    "float float-table",
    "wrap",
    "branch",
    "ert",
    "phantom",
    "index-marker",
    "nomencl",
    "argument short-title",
  ];
  for (const kind of kinds) {
    // Index/Nomencl chips carry a leading anchor between the wrapper and the
    // details element, so the regex allows an optional <a id>.
    const anchor = `(?:<a id="[^"]*"(?: data-ref="[^"]*")?></a>)?`;
    assertMatch(
      html,
      new RegExp(`<ins class="change-inserted change-author-0" id="change-\\d+" data-ref="change-\\d+">${anchor}<details class="disclose ${kind}\\b`),
      `whole-inset inserted ${kind} must be wrapped`,
    );
    assertMatch(
      html,
      new RegExp(`<del class="change-deleted change-author-0" id="change-\\d+" data-ref="change-\\d+">${anchor}<details class="disclose ${kind}\\b`),
      `whole-inset deleted ${kind} must be wrapped`,
    );
  }
  // Phantom/HPhantom/VPhantom share the chip class; all three get both cases.
  assertEquals((html.match(/<ins class="change-inserted change-author-0" id="change-\d+" data-ref="change-\d+"><details class="disclose phantom\b/g) ?? []).length, 3);
  assertEquals((html.match(/<del class="change-deleted change-author-0" id="change-\d+" data-ref="change-\d+"><details class="disclose phantom\b/g) ?? []).length, 3);
  // Nested combos keep the outer whole-inset wrapper and a plain inner chip.
  assertStringIncludes(html, '<ins class="change-inserted change-author-0" id="change-33" data-ref="change-33"><details class="disclose box boxed"');
  assertStringIncludes(html, "Nested foot inside inserted box.");
  assertStringIncludes(html, '<del class="change-deleted change-author-0" id="change-34" data-ref="change-34"><details class="disclose float float-figure"');
  assertStringIncludes(html, "Nested foot inside deleted float.");
  assertStringIncludes(html, '<del class="change-deleted change-author-0" id="change-35" data-ref="change-35"><details class="disclose note note-note"');
  assertStringIncludes(html, "Nested box inside deleted note.");
  assertStringIncludes(html, '<ins class="change-inserted change-author-0" id="change-36" data-ref="change-36"><details class="disclose branch"');
  assertStringIncludes(html, "Nested comment inside inserted branch.");
  // Numbering: the deleted footnote shows its would-be number without
  // consuming it (1 existing, 2 inserted foot, 3 deleted would-be + nested
  // foot in the inserted box, 4 nested would-be in the deleted float).
  assertEquals((html.match(/class="foot_label">1<\/summary>/g) ?? []).length, 1);
  assertEquals((html.match(/class="foot_label">2<\/summary>/g) ?? []).length, 1);
  assertEquals((html.match(/class="foot_label">3<\/summary>/g) ?? []).length, 2);
  assertEquals((html.match(/class="foot_label">4<\/summary>/g) ?? []).length, 1);
});

Deno.test("Live renderer - title, author, abstract, and math", async () => {
  const { html } = await renderFile("front_matter_math.lyx");
  assertMatch(html, /<h1 class="title"[^>]*>Title<\/h1>/);
  assertMatch(html, /<div class="author"[^>]*>My name/);
  assertStringIncludes(html, 'class="disclose foot foot_intitle"');
  assertStringIncludes(html, 'class="foot_intitle_label">*</summary>');
  assertStringIncludes(html, "Details about me");
  assertStringIncludes(html, '<div class="abstract">');
  assertStringIncludes(html, '<span class="abstract_label">Abstract</span>');
  assertMatch(html, /<div class="abstract_item"[^>]*>Abstract<\/div>/);
  assertMatch(html, /<div class="abstract_item"[^>]*>Keywords: one<\/div>/);
  assert(!html.includes('<div class="abstract">Abstract</div>'), "abstracts must be grouped, not repeated as sibling blocks");
  assertStringIncludes(html, '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block">');
  assertStringIncludes(html, "<mi>ζ</mi>");
  assertStringIncludes(html, 'encoding="application/x-tex"');
  const sem = normalizeReaderHtml(html);
  const dump = formatSem(sem);
  assertStringIncludes(dump, "title");
  assertStringIncludes(dump, "author");
  assertStringIncludes(dump, "abstract");
  assertStringIncludes(dump, "formula");
});

Deno.test("Live renderer - my_template front matter and math", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/my_template.lyx", import.meta.url));
  const text = await Deno.readTextFile(filePath);
  const { html } = await renderLiveHtml(parse(text), { filePath });
  assertMatch(html, /<h1 class="title"[^>]*>Title<\/h1>/);
  assertMatch(html, /<div class="author"[^>]*>My name/);
  assertStringIncludes(html, '<span class="abstract_label">Abstract</span>');
  assertMatch(html, /<div class="abstract_item"[^>]*>Keywords:/);
  assertMatch(html, /<div class="abstract_item"[^>]*>JEL:/);
  assertStringIncludes(html, 'display="block"');
  assertStringIncludes(html, "<mi>ζ</mi>");
  assertStringIncludes(html, "∑");
  assert(!html.includes("\\begin{equation}"), "display math must not dump the TeX environment");
  assert(!html.includes('stretchy="true"'), "\\left/\\right must not emit stretchy fences");
  assertMatch(html, /<a class="ref"[^>]*href="#sec_Section_label"[^>]*>1<\/a>/);
  assertMatch(html, /<a class="ref"[^>]*href="#subsec_subsec_label"[^>]*>1\.1<\/a>/);
  assertStringIncludes(html, 'id="sec_Section_label"');
  assert(!html.includes("sec:Section_label"), "refs must resolve to numbers, not raw keys");
  assertMatch(html, /<h4\b[^>]*>(?:<span class="heading-number">)?1\.1\.1 (?:<\/span>)?Subsubsection/);
  assertStringIncludes(html, 'class="float-table"');
  assertMatch(html, /Table 1: (?:<\/span>)?(?:<span[^>]*>)?Table caption/);
  assertMatch(html, /(?:<span class="heading-number">A <\/span>|>A )Appendix/);
  assertStringIncludes(html, 'href="#LyXCite-Abernethy2003"');
  assertStringIncludes(html, "Abernethy et al.");
  assertStringIncludes(html, "Abernethy, Colin D. et al. (2003)");
  assertStringIncludes(html, "In: <i>J. Am. Chem. Soc.</i>");
  assertStringIncludes(html, "doi: 10.1021/ja0276321");
  assertStringIncludes(html, "References");
  assertStringIncludes(html, '<span class="bibtexlabel">1</span>');
  assertStringIncludes(html, "colspan=");
  assertStringIncludes(html, "border-top:");
  assert(!html.includes('<div class="date">'), "preamble \\date is LaTeX-only; native XHTML omits it");
  assertStringIncludes(html, "data-filename=\"beamer-g4.jpg\"");
  assertStringIncludes(html, "data-filepath=");
  const fig = html.slice(html.indexOf("<figure"), html.indexOf("</figure>") + 9);
  const capAt = fig.indexOf("<figcaption");
  const tableAt = fig.indexOf("<table");
  assert(capAt !== -1 && tableAt !== -1 && capAt < tableAt, "figure caption must appear above the figure body");
  assertMatch(fig, /<span class="float-caption-prefix">Figure 1: <\/span>/);
  assertMatch(fig, /Figure caption/);
  assertStringIncludes(fig, 'class="float-caption-Standard"');
  assert(
    !/<figcaption[^>]*>(?:<span class="float-caption-prefix">)?Figure 1: (?:<\/span>)?<div/.test(fig),
    "figure number and caption must be one line",
  );
});

Deno.test({
  name: "Live renderer - every Help/*.lyx renders",
  timeout: 120000,
  fn: async () => {
    const names = await listHelpLyx();
    const failures: string[] = [];
    for (const name of names) {
      const filePath = join(HELP_DIR, name);
      try {
        const text = await Deno.readTextFile(filePath);
        const { html } = await renderLiveHtml(parse(text), { filePath });
        if (!html.includes('<article class="lyx-live">')) {
          failures.push(`${name}: missing article wrapper`);
        }
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    assertEquals(failures, [], failures.join("\n"));
  },
});

Deno.test("Live renderer - dialog-toggle Info icons use icon.aliases (dialog-show_*)", async () => {
  const { html } = await renderFile("info_icon_shortcut.lyx");
    // data-info-icon is only set on resolved <img> (glyph fallback has aria-label only).
    assertStringIncludes(html, 'data-info-icon="dialog-toggle findreplace"');
    assertStringIncludes(html, 'data-info-icon="dialog-toggle toc"');
    // The resolved (post icon.aliases) file name rides alongside for oracle parity.
    assertStringIncludes(html, 'data-info-file="dialog-show_findreplace"');
    assertStringIncludes(html, 'data-info-file="dialog-show_toc"');
    assert(
      /<img\b[^>]*data-info-icon="dialog-toggle findreplace"/.test(html),
    "dialog-toggle findreplace must resolve via icon.aliases → dialog-show_findreplace",
  );
  assert(
    /<img\b[^>]*data-info-icon="dialog-toggle toc"/.test(html),
    "dialog-toggle toc must resolve via icon.aliases → dialog-show_toc",
  );
});

Deno.test("Live renderer - Help Math.lyx Phantom chips; no math-mode UNKNOWN dump", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/Math.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, '<article class="lyx-live">');
  const unknown = diagnostics.filter((d) => d.code === "UNKNOWN_INSET");
  assertEquals(unknown.map((d) => d.message), []);
  // DL131: Phantom is a Live-only plain-text chip (native XHTML still drops it).
  assert(!html.includes("unknown-inset"), "Phantom must not fall back to unknown-inset");
  assertStringIncludes(html, 'class="disclose phantom"');
  assertStringIncludes(html, "<kbd");
  assert(!html.includes('<span class="info">math-mode</span>'), "Info shortcuts must not dump the raw LFUN name as body text");
  // When system bind files are present, resolve LFUN → key chord (keep LFUN in title).
  if (html.includes('title="math-mode"')) {
    assertStringIncludes(html, "Ctrl+M");
    assert(!html.includes(">math-mode</kbd>"), "resolved shortcuts must show the key, not the LFUN body");
  }
  // DL130 J4: classic PNG when LyX images are on disk; else glyph fallback.
  if (html.includes('data-info-icon="math-mode"')) {
    assertStringIncludes(html, '<img class="info-icon"');
    assertStringIncludes(html, "data:image/png;base64,");
  } else {
    assertStringIncludes(html, 'aria-label="math-mode"');
  }
  assertStringIncludes(html, "class=\"typewriter\"");
  assertStringIncludes(html, "class=\"sans\"");
  assertStringIncludes(html, "\u2423");
  assertStringIncludes(html, "<mo>↓</mo>");
  assertStringIncludes(html, "<mfrac>");
  assertStringIncludes(html, "<mtable>");
  assertStringIncludes(html, "<mi>A</mi>");
  assertStringIncludes(html, "<mo>≈</mo>");
  assertStringIncludes(html, "<mo>←</mo>");
  assertStringIncludes(html, "<mphantom>");
  assertStringIncludes(html, "mmultiscripts");
  assertStringIncludes(html, "⏞");
  // DL130 Step 5: chem bonds + preamble aliases must not dump as <mi>\cmd</mi>.
  assert(!html.includes("<mi>\\dbond</mi>"));
  assert(!html.includes("<mi>\\tbond</mi>"));
  assert(!html.includes("<mi>\\hyphen</mi>"));
  assert(!html.includes("<mi>\\gr</mi>"));
  assert(!html.includes("<mi>\\us</mi>"));
  assert(!html.includes("<mi>\\cb</mi>"));
  assert(!html.includes("<mi>\\fb</mi>"));
  assertStringIncludes(html, "⟹"); // \gr → \Longrightarrow via preamble newcommand
  // Info icon with LFUN args: spaces → underscores in LyX images/classic/.
  assertStringIncludes(html, 'data-info-icon="math-macro newmacroname_newcommand"');
  assert(
    html.includes('data-info-icon="math-macro newmacroname_newcommand"') &&
      html.includes("data:image/png;base64,"),
    "math-macro toolbar Info icon must resolve classic PNG (not missing/glyph-only)",
  );
  assert(!html.includes('encoding="application/x-tex">$\\begin{cases}'), "multi-line cases must include the body, not only the first line");
  assert(
    !html.includes('encoding="application/x-tex">\\newcommand{\\qG}'),
    "FormulaMacro must not be rendered as a formula",
  );
  assertStringIncludes(html, 'note-greyedout');
  assertStringIncludes(html, "color:#A0A0A0");
  assertStringIncludes(html, 'mathbackground="yellow"');
  assertStringIncludes(html, 'voffset="2mm"');
  assertStringIncludes(html, 'mathcolor="red"');
  assertStringIncludes(html, "\\int A\\,\\mathrm{d}x");
  assert(
    !html.includes("<mtext></mtext><annotation encoding=\"application/x-tex\"></annotation>"),
    "display formulas whose body starts with \\int must not collapse to empty MathML",
  );
  assertStringIncludes(html, "(something)");
  assertStringIncludes(html, "<mo>⟨</mo>");
  assertStringIncludes(html, "updiagonalstrike");
  assertStringIncludes(html, "mod ");
  assertStringIncludes(html, "<munderover>");
  assertStringIncludes(html, "<mtd><mi>A</mi></mtd><mtd><mo>→</mo></mtd><mtd><mi>B</mi></mtd>");
  const cdAt = html.indexOf("<mtd><mi>A</mi></mtd><mtd><mo>→</mo></mtd><mtd><mi>B</mi></mtd>");
  const cdChunk = html.slice(cdAt, html.indexOf("</math>", cdAt) + 7);
  assert(!cdChunk.includes('class="eqno"'), "amscd \\[ \\] diagrams must not get equation numbers");
  const cfracAt = html.indexOf("\\cfrac[l]{A}");
  assert(cfracAt !== -1, "Math.lyx \\[ cfrac display missing");
  const cfracEnd = html.indexOf("</math>", cfracAt);
  const cfracAfter = html.slice(cfracEnd, cfracEnd + 80);
  assert(!cfracAfter.includes('class="eqno"'), "\\[ display math must not get an equation number");
  const redAt = html.indexOf("\\textcolor{red}{\\int A=B}");
  assert(redAt !== -1, "Math.lyx numbered textcolor integral missing");
  const redEnd = html.indexOf("</math>", redAt);
  const redAfter = html.slice(redEnd, redEnd + 80);
  assert(redAfter.includes('class="eqno">(2)</span>'), `equation env after the first numbered formula should be (2), got ${redAfter}`);
  assertStringIncludes(html, 'class="eqno">(1)</span>');
  assertStringIncludes(html, 'class="eqno">(something)</span>');
  assertStringIncludes(html, 'class="eqno">something</span>');
  const gatherProse = html.indexOf("Every line can be numbered");
  assert(gatherProse !== -1, "Math.lyx gather section missing");
  const gatherBlock = html.slice(gatherProse, gatherProse + 2500);
  assert(
    (gatherBlock.match(/class="formula-row"/g) ?? []).length >= 2,
    "gather A=1 and X=-1 must be separate rows",
  );
  assert(gatherBlock.includes('class="eqno">'), "gather lines are numbered");
  const gatherNos = [...gatherBlock.matchAll(/class="eqno">\(([^)]*)\)/g)].map((m) => m[1]);
  assert(gatherNos.length >= 2, `gather should number both lines, got ${gatherNos.join(",")}`);
  assertEquals((html.match(/class="eqno"/g) ?? []).length, 36, "per-line gather/align/eqnarray numbers plus \\tag/\\tag*");
  assertStringIncludes(html, 'class="subequations"');
  const subref = html.match(/href="#eq_b">\(([^)]+)\)/);
  assert(subref !== null && /a$/.test(subref[1]), `subequation ref should be like (Na), got ${subref?.[1]}`);
  assertStringIncludes(html, 'mathsize="75%"');
  assertStringIncludes(html, 'class="href"');
  assertStringIncludes(html, '<nav class="toc">');
  assertStringIncludes(html, "„"); // Quotes gld German
  assertStringIncludes(html, "“");
  assertMatch(html, /<h3\b[^>]*>Command Scheme<\/h3>/); // Subsection* unnumbered (J2)
  assertMatch(html, /<h4\b[^>]*>Advice for Integrals<\/h4>/); // Subsubsection*
  assertStringIncludes(html, 'class="Boxed"');
  assertStringIncludes(html, "<br>");
  assertStringIncludes(html, "<hr>");
  assertStringIncludes(html, 'class="index"');
  assertStringIncludes(html, '<pre class="lyx_code">');
  assertStringIncludes(html, '<blockquote class="quote">');
});

Deno.test("Live renderer - Help Additional.lyx numbering, TOC, and SpecialChar", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/Additional.lyx", import.meta.url));
  const text = await Deno.readTextFile(filePath);
  const { html, diagnostics } = await renderLiveHtml(parse(text), { filePath });
  assertMatch(html, /Additional (?:<span class="specialchar"[^>]*>)?LyX(?:<\/span>)?/);
  assertMatch(html, /the (?:<span class="specialchar"[^>]*>)?LyX(?:<\/span>)?/);
  assertStringIncludes(html, "⇒");
  assert(!html.includes("<h1 class=\"title\">Additional \\SpecialChar"), "title SpecialChar must expand");
  assertStringIncludes(html, "User&#39;s Guide.");
  assertMatch(
    html,
    /(?:<span class="heading-number">2\.1 <\/span>|>2\.1 )How (?:<span class="specialchar"[^>]*>)?LyX(?:<\/span>)? Uses (?:<span class="specialchar"[^>]*>)?LaTeX(?:<\/span>)?</,
  );
  assertStringIncludes(html, 'id="sec-2-1"');
  assertStringIncludes(html, "<nav class=\"toc\">");
  assertStringIncludes(html, "href=\"#sec-2-1\"");
  assertStringIncludes(html, "2.1 How LyX Uses LaTeX");
  const labeling = html.indexOf("The final output contains no page numbers");
  assert(labeling !== -1, "Additional.lyx Labeling example missing");
  const labelingBefore = html.slice(Math.max(0, labeling - 160), labeling);
  assert(
    labelingBefore.includes("<ol") || labelingBefore.includes("<li"),
    `Labeling should use HTMLTag ol, got: …${labelingBefore.slice(-80)}`,
  );
  assert(!labelingBefore.includes('class="labeling"'), "Labeling must not fall back to a generic div");
  assertStringIncludes(html, 'class="flex_url"');
  assertStringIncludes(html, 'href="https://www.ams.org/publications/authors/tex/amslatex"');
  assertStringIncludes(html, 'class="flex_code"');
  assert(!html.includes("<code><div"), "Flex Code must stay inline");
  assertStringIncludes(html, '<dl class="description">');
  assertMatch(html, /<dt\b[^>]*>Address<\/dt>/);
  assertMatch(html, /<dt\b[^>]*>Current/);
  assertStringIncludes(html, "Current\u00a0Address</dt>");
  assertStringIncludes(html, 'class="Frameless"');
  assertStringIncludes(html, '<span class="noun">');
  const unknown = diagnostics.filter((d) => d.code === "UNKNOWN_INSET");
  assertEquals(unknown.map((d) => d.message), []);
  assertStringIncludes(html, "4.10.1.4 List Spacing");
  assert(!html.includes("List SpacingLists"), "Index inset must not leak into heading/TOC text");
  assertStringIncludes(html, "\u201c");
  assertStringIncludes(html, "\u201d");
  assertMatch(html, /<li\b[^>]*>resumed<\/li>/);
  assert(!html.includes('class="enumerate_resume"'), "Enumerate-Resume must not fall back to a generic div");
  assert(!html.includes("status collapsed"), "inset status lines must not leak into heading/TOC text");
  assertStringIncludes(html, '<span class="layout-label">Theorem 1.</span>');
  assertStringIncludes(html, "This is typically used for the statements of major results.");
  assertStringIncludes(html, '<span class="layout-label">Corollary.</span>');
  assertStringIncludes(html, '<span class="layout-label">Lemma 2.</span>');
  assertStringIncludes(html, 'class="hanging"');
  assertStringIncludes(html, "all but the first line of the paragraph is indented");
  assertStringIncludes(html, '<span class="dropcap">T</span>');
  assertStringIncludes(html, '<span class="dropcap-rest">his</span>');
  assertStringIncludes(html, "module adds a drop capitals paragraph style");
  assertStringIncludes(html, 'class="flex_rotatebox"');
  assertStringIncludes(html, "rotate(30deg)");
  assertStringIncludes(html, "Great Western Railway");
  assertStringIncludes(html, 'class="flex_multiple_columns"');
  assertStringIncludes(html, "column-count: 2");
  assertStringIncludes(html, "The Adventure of the Empty House");
  assert(!html.includes("{100.125}"), "non-LyX include (.tex) must be omitted like native XHTML");
  assertStringIncludes(html, 'class="href"');
  assertStringIncludes(html, 'class="Shadowbox"');
  assertStringIncludes(html, '<pre class="lyx_code">');
  // Shaped paragraphs + extended theorem-like layouts
  assertStringIncludes(html, 'class="heart"');
  assertStringIncludes(html, 'class="nut"');
  assertStringIncludes(html, 'class="proof"');
  assertStringIncludes(html, '<span class="layout-label">Proof.</span>');
  assertStringIncludes(html, '<span class="layout-label">Proposition');
  assertStringIncludes(html, '<span class="layout-label">Remark');
  assertStringIncludes(html, '<span class="layout-label">Algorithm.');
  assertStringIncludes(html, '<span class="layout-label">Definition.');
  assertStringIncludes(html, '<span class="layout-label">Example.');
  assertStringIncludes(html, 'class="index"');
  // Inline SpecialChar (inline-properties pass)
  assertStringIncludes(html, "\u2026"); // ldots
  assertStringIncludes(html, "\u00ad"); // softhyphen
  assertStringIncludes(html, "\u2044"); // breakableslash
  assertStringIncludes(html, "LaTeX2\u03b5");
});

Deno.test("Live renderer - Help UserGuide.lyx script, line, nomencl, Flex Emph", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/UserGuide.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, '<article class="lyx-live">');
  const unknown = diagnostics.filter((d) => d.code === "UNKNOWN_INSET");
  assertEquals(unknown.map((d) => d.message), []);
  assertMatch(html, /<sup><span[^>]*>[\s\S]*?a, b[\s\S]*?<\/span><\/sup>|<sup>[\s\S]*?a, b[\s\S]*?<\/sup>/);
  assertMatch(html, /<sub><span[^>]*>3x<\/span><\/sub>|<sub>3x<\/sub>/);
  assertStringIncludes(html, "<hr>");
  assertMatch(html, /<em class="flex_emph"><span[^>]*>Emph<\/span><\/em>/);
  assertMatch(html, /<strong class="flex_strong"><span[^>]*>Strong<\/span><\/strong>/);
  assertStringIncludes(html, '<div class="nomencl">');
  assertStringIncludes(html, ">Tab</a></dt>");
  assertMatch(html, /<dd\b[^>]*>Tabulator key<\/dd>/);
  assert(!html.includes("UNKNOWN_INSET"), "UserGuide must not dump unknown-inset fallbacks");
  assertMatch(html, /(?:<span class="heading-number">A <\/span>|>A )The User Interface/);
  assertMatch(html, /(?:<span class="heading-number">A\.1 <\/span>|>A\.1 )The File Menu/);
  assert(!html.includes(">7 The User Interface"), "appendix chapters must not continue arabic numbering");
  const phantomAt = html.indexOf("What is correct English");
  assert(phantomAt !== -1, "UserGuide phantom example missing");
  const phantomChunk = html.slice(phantomAt, phantomAt + 500);
  assertStringIncludes(phantomChunk, "has to be jumped");
  assertStringIncludes(phantomChunk, "jumps");
  assertStringIncludes(phantomChunk, 'class="disclose phantom"');
  assert(
    !phantomChunk.includes("\u200b"),
    "Phantom chip must not emit a zero-width space placeholder",
  );
  // Branches: Question selected; Answer not — only inverted Answer inset prints.
  assertStringIncludes(html, "Who was the first physics Nobel prize winner?");
  assertStringIncludes(html, "No answer:");
  assertStringIncludes(html, "branch is deactivated");
  assert(
    !html.includes("Wilhelm Conrad"),
    "inactive non-inverted Answer branch must omit like native XHTML",
  );
  // customHeadersFooters page chrome is not reader body (Live omits Header/Footer).
  // Prose may still mention “Magic code:” inside Description; the layout class must not appear.
  assert(!html.includes('class="center_footer"'), "Center Footer page chrome must omit");
  assert(!html.includes('class="left_header"'), "Left Header page chrome must omit");
  assert(!html.includes('class="right_footer"'), "Right Footer page chrome must omit");
  // Already-handled smoke promotions
  assertStringIncludes(html, 'class="href"');
  assertStringIncludes(html, 'href="lyx-docs@lists.lyx.org"');
  assertStringIncludes(html, '<nav class="toc">');
  assertStringIncludes(html, 'note-greyedout');
  assertStringIncludes(html, "<kbd");
  assertStringIncludes(html, "<br>");
  assertStringIncludes(html, "\u00a0"); // protected space
  assertStringIncludes(html, "“"); // Quotes eld
  assertStringIncludes(html, "”"); // Quotes erd
  assertStringIncludes(html, '<pre class="verbatim">');
  assertStringIncludes(html, "This is Verbatim.");
  assertStringIncludes(html, '<blockquote class="verse">');
  assertStringIncludes(html, '<blockquote class="quote">');
  assertStringIncludes(html, '<blockquote class="quotation">');
  assertStringIncludes(html, '<pre class="lyx_code">');
  assertStringIncludes(html, "#include");
  assertStringIncludes(html, 'class="right_address"');
  assertStringIncludes(html, 'class="Doublebox"');
  assertStringIncludes(html, "with rotated");
  assertStringIncludes(html, "This is a line");
  assertStringIncludes(html, 'class="preview"');
  const prevAt = html.indexOf('class="preview"');
  assert(prevAt !== -1 && html.slice(prevAt, prevAt + 200).includes("This is a line"), "Preview wraps demo line");
  assertStringIncludes(html, 'class="Frameless"');
  assertStringIncludes(html, "disclose marginal");
  assertStringIncludes(html, 'class="flex_code"');
  assertStringIncludes(html, 'class="flex_url"');
  assertStringIncludes(html, 'class="noun"');
  // Quote-style table: multiple language marks (not only English eld/erd)
  assertStringIncludes(html, "«");
  assertStringIncludes(html, "»");
  assertStringIncludes(html, "„");
  assertStringIncludes(html, "「");
  assertStringIncludes(html, "『");
  assertStringIncludes(html, "《");
  assertStringIncludes(html, "‹");
  assertStringIncludes(html, "›");
  const helloLi = html.search(/<li\b[^>]*>Hello/);
  assert(helloLi !== -1, "UserGuide 3.4.6 Hello item missing");
  const helloAt = html.lastIndexOf("<ol", helloLi);
  const hiLi = html.search(/<li\b[^>]*>Hi/);
  const nest = html.slice(helloAt, hiLi === -1 ? undefined : hiLi);
  assertStringIncludes(nest, 'class="enumi"');
  assertStringIncludes(nest, 'class="enumii"');
  assertStringIncludes(nest, 'class="enumiii"');
  assertMatch(nest, /<li\b[^>]*>this is an/);
  assertMatch(nest, /<li\b[^>]*>enumeration<\/li>/);
  assertMatch(nest, /<li\b[^>]*>itemize list<\/li>/);
  const itemizeAt = nest.search(/<li\b[^>]*>itemize list<\/li>/);
  const enumEnd = nest.search(/<li\b[^>]*>enumeration<\/li>/);
  assert(itemizeAt > enumEnd, "itemize must follow the inner enumeration");
  assert(
    nest.slice(0, itemizeAt).includes("enumiii") && nest.includes("</ol><ul>"),
    "itemize must stay nested beside the inner enumeration, not restart at the top level",
  );
  assert(
    /<h2 class="(?:bibliography|bibtex)"/.test(html) &&
      (html.includes("References") || html.includes("Bibliography")),
    "Bibliography environment must emit a References/Bibliography heading",
  );
  assertStringIncludes(html, 'id="LyXCite-lyxcredit"');
  assertStringIncludes(html, '<span class="bibitemlabel">Credits</span>');
  assertMatch(
    html,
    /The (?:<span class="specialchar"[^>]*>)?LaTeX(?:<\/span>)? Companion Second Edition/,
  );
  assertStringIncludes(html, 'class="bibtex"');
  assertStringIncludes(html, 'id="LyXCite-Mittelbach"');
  assertStringIncludes(html, '<span class="bibtexlabel">1</span>');
  assertMatch(html, /The (?:<span class="specialchar"[^>]*>)?LaTeX(?:<\/span>)? Companion/);
  assertStringIncludes(html, '<dt><a class="nomencl" href="#nomencl-');
  assertStringIncludes(html, 'id="nomencl-');
  assertStringIncludes(html, '<a href="#idx-');
  assertStringIncludes(html, 'id="idx-');
  assertStringIncludes(html, 'style="text-align: right"');
  assertStringIncludes(html, 'mathvariant="double-struck"');
  assertStringIncludes(html, "<mo>↻</mo>");
  assertStringIncludes(html, 'class="wline"');
  assertStringIncludes(html, "This is text with Wavy underlining on.");
  assertStringIncludes(html, 'class="dline"');
  assertStringIncludes(html, "This is text with Double underlining on.");
  assertStringIncludes(html, 'font-size: x-small');
  assertStringIncludes(html, "This is the");
  assertStringIncludes(html, 'font-style: oblique'); // shape slanted (native FT_SLANTED)
  assertStringIncludes(html, "This is the Slanted font shape");
  assertStringIncludes(html, "font-variant: small-caps"); // shape smallcaps
  assertStringIncludes(html, "This is the Small caps font shape");
  assertStringIncludes(html, "<s>"); // strikeout
  assertStringIncludes(html, 'style="color: blue"');
  assertStringIncludes(html, 'style="color: red"');
  assertStringIncludes(html, 'style="color: green"');
  assertStringIncludes(html, "\u2044"); // breakableslash
  assertStringIncludes(html, "\u200b"); // allowbreak
  assertStringIncludes(html, "This paragraph is right aligned");
  assertStringIncludes(html, 'style="text-align: center"');
  assertStringIncludes(html, "this one is centered");
  assertStringIncludes(html, 'style="text-align: left"');
  assertStringIncludes(html, "this one is left aligned");
  assertMatch(html, /<dt\b[^>]*>Vector\u00a0fonts/);
  assert(!html.includes("fontsrange"), "Index params must not leak into Description labels");
  assert(!html.includes("status collapsedFonts"), "Index status must not leak into Description");
  assertStringIncludes(html, '<div class="index">');
  assertStringIncludes(html, '<h2 class="index">Index</h2>');
  assertMatch(html, /<li\b[^>]*>Font, Types/);
  assertMatch(html, /(?:<span class="heading-number">3\.3\.4\.4 <\/span>|>3\.3\.4\.4 )Short Titles</);
  assert(!html.includes("HeadingsShort Titles"), "short-title Argument must not concatenate onto the long heading in the TOC");
});

Deno.test("Live renderer - Help EmbeddedObjects.lyx margin notes, wrap, listings", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/EmbeddedObjects.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, '<article class="lyx-live">');
  const unknown = diagnostics.filter((d) => d.code === "UNKNOWN_INSET");
  assertEquals(unknown.map((d) => d.message), []);
  assertStringIncludes(html, 'class="disclose marginal"');
  assertStringIncludes(html, "This is a margin note.");
  assertStringIncludes(html, 'class="wrap wrap-left"');
  assertStringIncludes(html, "width: 40%");
  assertStringIncludes(html, "<figcaption");
  assertStringIncludes(html, "Figure 6.1: ");
  assertStringIncludes(html, 'class="float-caption-Standard"');
  assertStringIncludes(html, "This is a wrapped figure float.");
  assertStringIncludes(html, 'href="#fig_This_is_a">6.1</a>');
  assertStringIncludes(html, 'data-filename="2D-intensity-plot.pdf"');
  assertStringIncludes(html, "width: 100%");
  assertStringIncludes(html, 'data-filename="Star-structure.pdf"');
  assertStringIncludes(html, "width: 50%");
  assert(
    html.includes("data:image/png;base64,") || html.includes("2D-intensity-plot.pdf"),
    "PDF figures must still name the source file",
  );
  assertStringIncludes(html, '<code class="listings C++">');
  assertStringIncludes(html, "int a=5;");
  assertStringIncludes(html, '<div class="float-listings">');
  assertStringIncludes(html, "listings-caption");
  assertStringIncludes(html, "Listing 8.1: ");
  assertStringIncludes(html, "Example Listing float");
  assertStringIncludes(html, 'href="#lst_Example_Listing">8.1</a>');
  assertStringIncludes(html, 'href="#lst_file_listing">8.2</a>');
  assertStringIncludes(html, "Listing 8.2: ");
  assertStringIncludes(html, "Lines 10 - 15 of this LyX file");
  assertStringIncludes(html, "\\usepackage[figure]{hypcap}");
  assertStringIncludes(html, "Listing 8.3: ");
  assertStringIncludes(html, "def func(param):");
  assertStringIncludes(html, 'data-filename="Abstract.pdf"');
  assertStringIncludes(html, "Algorithm 3.1: ");
  assertStringIncludes(html, "Example Algorithm float");
  assertStringIncludes(html, "This is a small dummy child document");
  assertStringIncludes(html, "External Subsection 1");
  assertStringIncludes(html, '<pre class="include">');
  assert(
    !html.includes("\\end_header"),
    "lstinputlisting of this file must honor firstline/lastline, not dump the whole .lyx source",
  );
  // Caption Below / Unnumbered (native float-caption-{type}; caption* has no number prefix)
  assertStringIncludes(html, 'class="float-caption-Below"');
  assertStringIncludes(html, "A caption marked as being below the table.");
  const belowAt = html.indexOf("A caption marked as being below the table.");
  assert(belowAt !== -1, "Caption Below text missing");
  const belowCap = html.lastIndexOf("<figcaption", belowAt);
  assert(belowCap !== -1 && html.slice(belowCap, belowAt).includes("float-caption-Below"), "Below class on figcaption");
  assert(/Table \d/.test(html.slice(belowCap, belowAt)), "Caption Below keeps Table N: prefix");
  assertStringIncludes(html, 'class="float-caption-Unnumbered"');
  assertStringIncludes(html, "Continued Example Phone List");
  const contAt = html.indexOf("Continued Example Phone List");
  const contSpan = html.lastIndexOf("<span", contAt);
  assert(
    contSpan !== -1 && html.slice(contSpan, contAt).includes("float-caption-Unnumbered"),
    "longtable Caption Unnumbered wraps with float-caption-Unnumbered",
  );
  assert(
    !html.slice(Math.max(0, contAt - 80), contAt).includes("Table "),
    "Caption Unnumbered must not get a Table N: prefix",
  );
  // Boxes: native InsetBox::xhtml is div class="{type}" (+ optional width)
  for (const variant of ["Boxed", "Doublebox", "Framed", "Frameless", "Shaded", "Shadowbox", "ovalbox", "Ovalbox"]) {
    assertStringIncludes(html, `class="${variant}"`);
  }
  assertMatch(html, /class="disclose box \w+ box-full"/);
  assertMatch(html, /class="Boxed" style="width: 100%"/);
  assertStringIncludes(html, "Shadow box");
  assertStringIncludes(html, "Shaded background box");
  assertStringIncludes(html, "Oval box, thin");
  assertStringIncludes(html, "Double rectangular box");
  // Flex Minipage (Var. Width): wrap like native MultiPar Flex → div
  assertStringIncludes(html, "flex_minipage");
  const mpAt = html.indexOf("with line break");
  assert(mpAt !== -1, "Minipage body text missing");
  const mpOpen = html.lastIndexOf("flex_minipage", mpAt);
  assert(mpOpen !== -1 && mpOpen > mpAt - 200, "Minipage content must sit inside flex_minipage wrapper");
  assertStringIncludes(html.slice(mpOpen, mpAt + 20), "rotated cell");
  assertStringIncludes(html, 'class="href"');
  assertStringIncludes(html, '<nav class="toc">');
  assertStringIncludes(html, 'note-greyedout');
  assertStringIncludes(html, "<kbd");
  assertStringIncludes(html, "“");
  assertStringIncludes(html, "<br>");
  assertStringIncludes(html, 'class="dropcap"');
  assertStringIncludes(html, 'class="flex_reflectbox"');
  assertStringIncludes(html, 'class="flex_rotatebox"');
  assertStringIncludes(html, 'class="flex_scalebox"');
  assertStringIncludes(html, 'class="flex_resizebox"');
  assertStringIncludes(html, 'class="bibitemlabel"');
  assertStringIncludes(html, 'class="citation"');
  assertStringIncludes(html, "<hr>");
  assertStringIncludes(html, 'class="index"');
  assertStringIncludes(html, 'style="color: white"');
  assertStringIncludes(html, 'style="color: yellow"');
  assertStringIncludes(html, 'style="color: magenta"');
});

Deno.test("Live renderer - Help Formula-numbering.lyx refs and eqno", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/Formula-numbering.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, '<article class="lyx-live">');
  assertEquals(diagnostics.filter((d) => d.code === "UNKNOWN_INSET").map((d) => d.message), []);
  assert((html.match(/class="eqno"/g) ?? []).length >= 8, "Formula-numbering should emit equation numbers");
  assertStringIncludes(html, 'class="ref"');
  assertStringIncludes(html, "<hr>");
  assertStringIncludes(html, "<br>");
  assertStringIncludes(html, "<math");
});

Deno.test("Live renderer - Help Intro.lyx TOC, href, quotes, table", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/Intro.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, '<article class="lyx-live">');
  assertEquals(diagnostics.filter((d) => d.code === "UNKNOWN_INSET").map((d) => d.message), []);
  assertMatch(
    html,
    /<h1 class="title"[^>]*>Introduction to (?:<span class="specialchar"[^>]*>)?LyX(?:<\/span>)?<\/h1>/,
  );
  assertStringIncludes(html, '<nav class="toc">');
  assertStringIncludes(html, 'class="href"');
  assertStringIncludes(html, "lyx-docs@lists.lyx.org");
  assertStringIncludes(html, "“");
  assertStringIncludes(html, "”");
  assertStringIncludes(html, "<table");
  assertStringIncludes(html, "disclose foot");
  assertStringIncludes(html, "<br>");
});

Deno.test("Live renderer - Help Tutorial.lyx TOC, Info, LyX-Code, quotes", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/Tutorial.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, '<article class="lyx-live">');
  assertEquals(diagnostics.filter((d) => d.code === "UNKNOWN_INSET").map((d) => d.message), []);
  assertStringIncludes(html, '<nav class="toc">');
  assertStringIncludes(html, 'class="href"');
  assertStringIncludes(html, "<kbd");
  assertStringIncludes(html, '<pre class="lyx_code">');
  assertStringIncludes(html, "This is an introduction");
  assertStringIncludes(html, "“");
  assertStringIncludes(html, "disclose foot");
  assertStringIncludes(html, "<br>");
  assertStringIncludes(html, 'class="ref"');
  assertStringIncludes(html, "<table");
  assertStringIncludes(html, "<math");
  // Toolbar Info icons (buffer-view) — PNG data URI when classic/ images exist.
  assert(
    html.includes('data-info-icon="buffer-view"') || html.includes('aria-label="buffer-view"'),
    "Tutorial toolbar Info icons must render as img or glyph",
  );
  if (html.includes('data-info-icon="buffer-view"')) {
    assertStringIncludes(html, "data:image/png;base64,");
  }
});

Deno.test("Live renderer - Help Development.lyx multirow cells emit rowspan", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/Development.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, '<article class="lyx-live">');
  assertEquals(diagnostics.filter((d) => d.code === "UNKNOWN_INSET").map((d) => d.message), []);
  assertStringIncludes(html, 'rowspan="3"');
  const noCell = html.match(/<td\b([^>]*)>(?:<span\b[^>]*>)?No/);
  assert(noCell, "Development.lyx multirow 'No' cell missing");
  assert(noCell[1].includes('rowspan="3"'), "the 'No' cell is the start of a 3-row span");
});

Deno.test("Live renderer - Help Customization.lyx Description Flex Code labels", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/Customization.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, '<article class="lyx-live">');
  assertEquals(diagnostics.filter((d) => d.code === "UNKNOWN_INSET").map((d) => d.message), []);
  assertMatch(html, /<dt\b[^>]*><code class="flex_code"><span[^>]*>Format<\/span><\/code><\/dt>/);
  assert(!html.includes("status collapsedFormat"), "Flex Code status must not leak into Description labels");
  assert(
    !html.includes("International Keyboard Support"),
    "deselected OutDated branch must omit like native XHTML",
  );
  assert(
    !html.includes("Information from previous versions of this document"),
    "deselected OutDated branch intro must omit",
  );
  assertStringIncludes(html, 'class="href"');
  assertStringIncludes(html, '<nav class="toc">');
  assertStringIncludes(html, 'note-greyedout');
  assertStringIncludes(html, 'class="noun"');
  assertStringIncludes(html, 'class="flex_url"');
  assertStringIncludes(html, 'class="Shadowbox"');
  assertStringIncludes(html, '<code class="listings');
  assertStringIncludes(html, '<pre class="lyx_code">');
  assertStringIncludes(html, '<blockquote class="quote">');
  assertStringIncludes(html, "“");
  assertStringIncludes(html, "disclose foot");
  assertStringIncludes(html, "<br>");
});

Deno.test("Live renderer - Help Development.lyx listings, Flex Code, Paragraph", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/Development.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, '<article class="lyx-live">');
  assertEquals(diagnostics.filter((d) => d.code === "UNKNOWN_INSET").map((d) => d.message), []);
  assertStringIncludes(html, 'class="href"');
  assertStringIncludes(html, '<nav class="toc">');
  assertStringIncludes(html, 'note-greyedout');
  assertStringIncludes(html, 'class="flex_code"');
  assertStringIncludes(html, 'class="flex_url"');
  assertStringIncludes(html, '<code class="listings');
  assertStringIncludes(html, "“");
  assertStringIncludes(html, "disclose foot");
  assertStringIncludes(html, "<br>");
  assertMatch(html, /<h5\b[^>]*>Suspended tests<\/h5>/);
  assertStringIncludes(html, 'class="bibitemlabel"');
});

Deno.test("Live renderer - IPA / IPADeco are not UNKNOWN_INSET", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Modules/Linguistics.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  const unknown = diagnostics.filter((d) => d.code === "UNKNOWN_INSET");
  assertEquals(
    unknown.filter((d) => /IPA/.test(d.message)).map((d) => d.message),
    [],
    "IPA/IPADeco must be handled",
  );
  assertStringIncludes(html, 'class="ipa"');
  assertStringIncludes(html, "ipa-deco");
  assertStringIncludes(html, "\u035c"); // bottomtiebar combining mark
});

Deno.test("Live renderer - Tufte Flex sidenote and charstyles", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Handouts/Tufte_Handout.lyx", import.meta.url));
  const { html } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, 'class="sidenote marginal"');
  assertStringIncludes(html, 'class="marginnote marginal"');
  assertStringIncludes(html, 'class="smallcaps"');
  assertStringIncludes(html, "font-variant: small-caps");
  assertStringIncludes(html, "allcaps");
  assertStringIncludes(html, "text-transform: uppercase");
});

Deno.test("Live renderer - Beamer Alert and Structure Flex", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Presentations/Beamer.lyx", import.meta.url));
  const { html } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, 'class="alert"');
  assertStringIncludes(html, "#cc0000");
  assertStringIncludes(html, 'class="structure"');
  assertStringIncludes(html, "#0000aa");
});

Deno.test("Live renderer - Flex Color Box wraps content", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Modules/Fancy_Colored_Boxes.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertEquals(diagnostics.filter((d) => d.code === "UNKNOWN_INSET"), []);
  assertStringIncludes(html, 'class="color-box"');
  assertStringIncludes(html, "A basic color box.");
});

Deno.test("Live renderer - Chunk, Structure Tree, LilyPond, ChessBoard wrappers", async () => {
  const chunkPath = fromFileUrl(new URL("./fixtures/Modules/Noweb.lyx", import.meta.url));
  const chunk = await renderLiveHtml(parse(await Deno.readTextFile(chunkPath)), { filePath: chunkPath });
  assertStringIncludes(chunk.html, 'class="chunk"');
  assertStringIncludes(chunk.html, "chunk-title");

  const lingPath = fromFileUrl(new URL("./fixtures/Modules/Linguistics.lyx", import.meta.url));
  const ling = await renderLiveHtml(parse(await Deno.readTextFile(lingPath)), { filePath: lingPath });
  assertStringIncludes(ling.html, 'class="structure-tree"');

  const lilyPath = fromFileUrl(new URL("./fixtures/Modules/LilyPond_Book.lyx", import.meta.url));
  const lily = await renderLiveHtml(parse(await Deno.readTextFile(lilyPath)), { filePath: lilyPath });
  assertStringIncludes(lily.html, 'class="lilypond"');

  const chessPath = fromFileUrl(new URL("./fixtures/Modules/Chessboard.lyx", import.meta.url));
  const chess = await renderLiveHtml(parse(await Deno.readTextFile(chessPath)), { filePath: chessPath });
  assertStringIncludes(chess.html, 'class="chessboard"');
});

Deno.test("Live renderer - nameref uses heading and caption titles", async () => {
  const filePath = syntheticPath("nameref_titles.lyx");
  const { html } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, 'href="#sec_intro_name">Named Introduction</a>');
  assertStringIncludes(html, 'href="#sec_intro_name">1</a>');
  // Native LyXHTML nameref for floats is "Figure N", not the caption prose.
  assertStringIncludes(html, 'href="#fig_demo_cap">Figure 1</a>');
});

Deno.test("Live renderer - Flex InsetLayout HTMLTag/HTMLClass/Font from LocalLayout", async () => {
  const filePath = syntheticPath("flex_htmltag.lyx");
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertEquals(diagnostics.filter((d) => d.code === "UNKNOWN_INSET"), []);
  assertStringIncludes(html, '<mark class="probe-mark"');
  assertStringIncludes(html, "color:orange");
  assertStringIncludes(html, "Tagged");
  assert(!html.includes('class="flex probe"'), "layout HTMLClass must win over generic flex slug");
});

Deno.test("Live renderer - hostile layout HTMLTags fall back to classed wrappers (DL132 F2)", async () => {
  const filePath = syntheticPath("flex_hostile_htmltag.lyx");
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertEquals(diagnostics.filter((d) => d.code === "UNKNOWN_INSET"), []);
  for (const slug of ["hstyle", "hsvg", "hobject", "hlink"]) {
    assertStringIncludes(html, `class="flex ${slug}"`);
  }
  assert(!html.includes("<style"), "layout HTMLTag 'style' must not be emitted");
  assert(!html.includes("<svg"), "layout HTMLTag 'svg' must not be emitted");
  assert(!html.includes("<object"), "layout HTMLTag 'object' must not be emitted");
  assert(!html.includes("<link"), "layout HTMLTag 'link' must not be emitted");
});

Deno.test("Live renderer - duplicate citation keys render once (DL132 P6)", async () => {
  const filePath = syntheticPath("cite_dedup.lyx");
  const { html } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  const entries = html.match(/class="bibtexentry"/g) ?? [];
  assertEquals(entries.length, 2, "duplicate citation keys must render a single bibliography entry each");
  assertStringIncludes(html, "Author, Alpha");
  assertStringIncludes(html, "Author, Beta");
});

Deno.test("Live renderer - pageref uses target number not elsewhere", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/UserGuide.lyx", import.meta.url));
  const { html } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assert(!html.includes(">elsewhere</a>"), "pageref/vpageref must not hardcode elsewhere when a target exists");
  assertStringIncludes(html, 'href="#fig_Two_images"');
  assertStringIncludes(html, 'title="page reference');
  assertStringIncludes(html, ">4.2</a>");
});

Deno.test("Live renderer - lang property emits HTML lang spans", async () => {
  const filePath = fromFileUrl(new URL("./fixtures/Help/Additional.lyx", import.meta.url));
  const { html } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertStringIncludes(html, 'lang="de"');
  assertStringIncludes(html, 'lang="en"');
});

Deno.test("Live renderer - remaining Flex kinds get classed wrappers (no bare passthrough)", async () => {
  const samples: [string, string, string[]][] = [
    ["./fixtures/Presentations/Beamer.lyx", "beamer", ["flex alternative", "flex bold", 'class="flex']],
    ["./fixtures/Articles/Springer_Nature_Journals.lyx", "sn-jnl", ["data-field=", "flex field"]],
    ["./fixtures/Modules/Linguistics.lyx", "article", ["flex gloss", "groupglossedwords"]],
    ["./fixtures/Modules/Braille.lyx", "article", ["braillebox"]],
    ["./fixtures/Modules/PDF_Form.lyx", "scrartcl", ["pdf-form", "checkbox"]],
    ["./fixtures/Curricula_Vitae/Modern_CV.lyx", "moderncv", ["flex column"]],
  ];
  for (const [rel, textclass, needles] of samples) {
    if (!(await hasTextclassLayout(textclass))) continue;
    const filePath = fromFileUrl(new URL(rel, import.meta.url));
    const { html } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
    for (const n of needles) {
      assertStringIncludes(html.toLowerCase(), n.toLowerCase(), `${rel} missing ${n}`);
    }
  }
});

Deno.test("Live renderer - H-P, PDF comment/form, tablenotemark wrappers", async () => {
  const hpPath = fromFileUrl(new URL("./fixtures/Modules/Hazard_and_Precautionary_Statements.lyx", import.meta.url));
  const hp = await renderLiveHtml(parse(await Deno.readTextFile(hpPath)), { filePath: hpPath });
  assertStringIncludes(hp.html, 'class="hp-number"');
  assertStringIncludes(hp.html, 'class="hp-statement"');

  const pdfPath = fromFileUrl(new URL("./fixtures/Modules/PDF_Comments.lyx", import.meta.url));
  const pdf = await renderLiveHtml(parse(await Deno.readTextFile(pdfPath)), { filePath: pdfPath });
  assertStringIncludes(pdf.html, "pdf-comment");

  const formPath = fromFileUrl(new URL("./fixtures/Modules/PDF_Form.lyx", import.meta.url));
  const form = await renderLiveHtml(parse(await Deno.readTextFile(formPath)), { filePath: formPath });
  assertStringIncludes(form.html, "pdf-form");

  // Filename on disk keeps %28/%29 literally (not decoded parentheses).
  if (await hasTextclassLayout("aastex63")) {
    const aasPath = join(
      fromFileUrl(new URL("./fixtures/Articles/", import.meta.url)),
      "American_Astronomical_Society_%28AASTeX_v._6.3.1%29.lyx",
    );
    const aas = await renderLiveHtml(parse(await Deno.readTextFile(aasPath)), { filePath: aasPath });
    assertStringIncludes(aas.html, 'class="tablenotemark"');
  }
});

Deno.test("Live renderer - FloatList emits list of floats", async () => {
  // KOMA example has FloatList insets but no captioned floats → empty (like native).
  const koma = fromFileUrl(new URL("./fixtures/Books/KOMA-Script_Book.lyx", import.meta.url));
  const komaRender = await renderLiveHtml(parse(await Deno.readTextFile(koma)), { filePath: koma });
  assertEquals(
    komaRender.diagnostics.filter((d) => d.code === "UNKNOWN_INSET" && /FloatList/.test(d.message)),
    [],
  );

  const filePath = fromFileUrl(new URL("./fixtures/Modules/Multilingual_Captions.lyx", import.meta.url));
  const { html, diagnostics } = await renderLiveHtml(parse(await Deno.readTextFile(filePath)), { filePath });
  assertEquals(
    diagnostics.filter((d) => d.code === "UNKNOWN_INSET" && /FloatList/.test(d.message)).map((d) => d.message),
    [],
  );
  assertStringIncludes(html, 'class="toc toc-floats"');
  assertStringIncludes(html, "List of ");
  assertStringIncludes(html, 'href="#float-');
});

Deno.test("Live renderer - escape helper is applied to source-derived text", () => {
  assertEquals(escapeLiveHtml(`<a b="c">`), "&lt;a b=&quot;c&quot;&gt;");
});

Deno.test("Live CLI - parse failure does not emit html", async () => {
  const tmp = await Deno.makeTempFile({ suffix: ".lyx" });
  try {
    await Deno.writeTextFile(tmp, "not a lyx file");
    const raw = await runCliRaw(["preview", tmp]);
    assertEquals(raw.code, 1);
    const parsed = JSON.parse(raw.stdout);
    assertEquals(parsed.code, "PARSE_ERROR");
    assertEquals(parsed.html, undefined);
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("Live CLI - CRLF is recorded as crlf and does not spawn per-test LyX", async () => {
  const src = (await Deno.readTextFile(syntheticPath("headings_paragraphs.lyx"))).replaceAll("\r\n", "\n");
  const tmp = await Deno.makeTempFile({ suffix: ".lyx" });
  try {
    await Deno.writeTextFile(tmp, src.replaceAll("\n", "\r\n"));
    const result = await runCliTest(["preview", tmp]);
    const validated = validateLiveResponse(result);
    assertEquals(validated.source.lineEnding, "crlf");
    assertEquals(detectLineEnding(src.replaceAll("\n", "\r\n")), "crlf");
  } finally {
    await Deno.remove(tmp);
  }
});

Deno.test("Live CLI - extra arguments are rejected", async () => {
  const result = await runCliTest(["preview", syntheticPath("hostile.lyx"), "layout"]);
  assertEquals(result.code, "INVALID_FLAG");
});

Deno.test("Live comparison - incidental ids and classes are ignored", () => {
  const a = normalizeReaderHtml(`<div class="standard" id="magicparlabel-9">Hello</div>`);
  const b = normalizeReaderHtml(`<div class="standard">Hello</div>`);
  assert(semanticEqual(a, b), formatSem(a) + "\n---\n" + formatSem(b));
});

Deno.test("Live comparison - accepted view drops del and promotes ins (DL133 J4)", () => {
  const html = `<div class="standard">Visible<ins class="change-inserted" id="change-1" data-ref="change-1"> added</ins> and<del class="change-deleted" id="change-2" data-ref="change-2"> removed</del> text.</div>`;
  // Default: wrappers are transparent — all content survives normalization.
  const defaultView = normalizeReaderHtml(html);
  const defaultDump = formatSem(defaultView);
  assertStringIncludes(defaultDump, "added");
  assertStringIncludes(defaultDump, "removed");
  // Accepted: Clean projection — del subtree dropped, ins promoted to plain text.
  const accepted = normalizeReaderHtml(html, { changeView: "accepted" });
  const dump = formatSem(accepted);
  assertStringIncludes(dump, "added");
  assert(!dump.includes("removed"), "accepted view must drop deleted text");
  assert(!dump.includes("change-deleted") && !dump.includes("change-inserted"), "accepted view has no change wrappers");
});

Deno.test("Live comparison - resolved icon file name wins over the LFUN arg", () => {
  const live = normalizeReaderHtml(
    `<img class="info-icon" src="data:image/png;base64,aa" data-info-icon="dialog-toggle findreplace" data-info-file="dialog-show_findreplace"/>`,
  );
  const native = normalizeReaderHtml(
    `<img class="info-icon" src="e_44f05612a5aa_dialog-show_findreplace.svg" alt="image: e_44f05612a5aa_dialog-show_findreplace.svg"/>`,
  );
  assert(semanticEqual(live, native), formatSem(live) + "\n---\n" + formatSem(native));
});

Deno.test("Live comparison - DL130 tolerances (pageref text, icon markup, shortcut tag)", () => {
  // J1: pageref link text (figure number vs PDF page) must not break equality when target matches.
  const livePage = normalizeReaderHtml(
    `<a class="ref" href="#fig_Two_images" title="page reference (Live shows target number/name, not a page)">4.2</a>`,
  );
  const nativePage = normalizeReaderHtml(
    `<a class="ref pageref" href="#fig_Two_images">12</a>`,
  );
  assert(semanticEqual(livePage, nativePage), formatSem(livePage) + "\n---\n" + formatSem(nativePage));

  // Non-pageref refs still compare visible text.
  const liveRef = normalizeReaderHtml(`<a class="ref" href="#sec_a">1</a>`);
  const nativeRef = normalizeReaderHtml(`<a class="ref" href="#sec_a">Introduction</a>`);
  assert(!semanticEqual(liveRef, nativeRef), "ordinary ref text must still be compared");

  // J4: glyph vs img — same icon name.
  const glyph = normalizeReaderHtml(
    `<span class="info-icon" title="buffer-view" role="img" aria-label="buffer-view">▣</span>`,
  );
  const png = normalizeReaderHtml(
    `<img class="info-icon" src="data:image/png;base64,aa" alt="buffer-view" aria-label="buffer-view"/>`,
  );
  assert(semanticEqual(glyph, png), formatSem(glyph) + "\n---\n" + formatSem(png));

  // J5: kbd vs native-ish bdo — same chord text.
  const kbd = normalizeReaderHtml(`<kbd class="shortcuts" title="math-mode">Ctrl+M</kbd>`);
  const bdo = normalizeReaderHtml(`<bdo class="shortcuts" dir="ltr">Ctrl+M</bdo>`);
  assert(semanticEqual(kbd, bdo), formatSem(kbd) + "\n---\n" + formatSem(bdo));
});

Deno.test("Live CSP floor - restrictive policy string has no remote sources", () => {
  // script-src may be 'none' or nonce-'…' for outline scroll; still no remote scripts/URLs.
  const cspNone =
    "default-src 'none'; img-src vscode-webview: data:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  const cspNonce =
    "default-src 'none'; img-src vscode-webview: data:; style-src 'unsafe-inline'; script-src 'nonce-abc'; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
  for (const csp of [cspNone, cspNonce]) {
    assertStringIncludes(csp, "default-src 'none'");
    assert(/script-src ('none'|'nonce-[^']+')/.test(csp), "script-src must be none or nonce-only");
    assert(!/https?:\/\//.test(csp), "CSP must not allow remote http(s) URLs");
  }
});

Deno.test("findMagick discovers magick on PATH when bundled is absent (DL148)", () => {
  const dir = Deno.makeTempDirSync({ prefix: "lq-magick-" });
  const stubName = Deno.build.os === "windows" ? "magick.exe" : "magick";
  const stub = join(dir, stubName);
  Deno.writeFileSync(stub, new Uint8Array(0));
  const prevPath = Deno.env.get("PATH");
  const prevMagick = Deno.env.get("MAGICK_BINARY");
  const prevLocal = Deno.env.get("LOCALAPPDATA");
  try {
    Deno.env.delete("MAGICK_BINARY");
    Deno.env.delete("LOCALAPPDATA");
    Deno.env.set("PATH", dir);
    assertEquals(findMagick(undefined), stub);
  } finally {
    if (prevPath === undefined) Deno.env.delete("PATH");
    else Deno.env.set("PATH", prevPath);
    if (prevMagick === undefined) Deno.env.delete("MAGICK_BINARY");
    else Deno.env.set("MAGICK_BINARY", prevMagick);
    if (prevLocal === undefined) Deno.env.delete("LOCALAPPDATA");
    else Deno.env.set("LOCALAPPDATA", prevLocal);
    try {
      Deno.removeSync(dir, { recursive: true });
    } catch {
      // ignore cleanup races
    }
  }
});

Deno.test("Live renderer - appendix frame and lettering when marker is on Standard (DL152)", async () => {
  const { html, outline } = await renderFile("appendix_marker.lyx");
  assertStringIncludes(html, '<div class="appendix-frame">');
  assertStringIncludes(html, '<span class="appendix-label">Appendix</span>');
  assertMatch(html, /<span class="heading-number">1 <\/span>Main/);
  assertMatch(html, /<span class="heading-number">A <\/span>First appendix/);
  assertMatch(html, /<span class="heading-number">A\.1 <\/span>Nested/);
  assert(!html.includes(">2 First appendix"), "appendix section must not continue arabic numbering");
  const frameAt = html.indexOf('class="appendix-frame"');
  assert(frameAt !== -1);
  assert(
    html.indexOf("Main") < frameAt,
    "main-text heading stays outside the appendix frame",
  );
  assert(
    html.indexOf("First appendix") > frameAt,
    "appendix heading sits inside the frame",
  );
  const firstApp = outline.find((e) => e.text === "First appendix");
  assertEquals(firstApp?.number.trim(), "A");
  const nested = outline.find((e) => e.text === "Nested");
  assertEquals(nested?.number.trim(), "A.1");
  assert(
    !outline.some((e) => e.text === "Appendix"),
    "frame label must not appear in the TOC outline",
  );
});

Deno.test("Live renderer - nested Float is a subfloat (DL152)", async () => {
  const { html, navigate } = await renderFile("subfloat_figures.lyx");
  assertStringIncludes(html, ">Float: Figure</summary>");
  assertStringIncludes(html, ">Subfloat: Figure</summary>");
  assertStringIncludes(html, '<span class="float-caption-prefix">Figure 1: </span>');
  assertStringIncludes(html, '<span class="float-caption-prefix">Subfigure a: </span>');
  assertStringIncludes(html, '<span class="float-caption-prefix">Subfigure b: </span>');
  assertStringIncludes(html, '<span class="float-caption-prefix">Figure 2: </span>');
  assert(!html.includes("Figure 3:"), "nested floats must not consume the main figure counter");
  assertMatch(html, /<figure class="[^"]*\bsubfloat\b[^"]*"/);
  assertEquals(navigate.figures.map((e) => e.number), ["1", "2"]);
  assertEquals(navigate.figures[0]?.text, "Outer");
  assertEquals(
    (navigate.figures[0]?.children ?? []).map((c) => `${c.number} ${c.text}`),
    ["a Left", "b Right"],
  );
  assertEquals(navigate.figures[1]?.text, "After");
  assertEquals(navigate.figures[1]?.children?.length ?? 0, 0);
});
