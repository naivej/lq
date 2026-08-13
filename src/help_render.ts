/**
 * help_render.ts — renderers for the built-in help.
 *
 * The text renderer is the deterministic floor: no width assumptions, no
 * color, readable when redirected. The rich renderer is a safe ANSI subset:
 * colored headings, emphasized safety markers, uniform code styling (every
 * code span and block in one color), and the home splash logo. Tables and
 * examples keep the deterministic text layout — no width-aware realignment,
 * no token-level syntax highlighting, no hyperlinks, no pager.
 *
 * Every ANSI run is self-closed (`<style>…\x1b[0m`), so rich output stripped
 * of escapes equals the text output exactly.
 */
import { groupedPages, reachOf, type HelpPage } from "./help.ts";

/** `--rich` value: `auto` adapts to terminal interactivity. */
export type RichMode = "auto" | "always" | "never";

const ANSI = {
  reset: "\x1b[0m",
  /** Bold bright cyan — page headers and section headings. */
  heading: "\x1b[1;36m",
  /** Cyan — uniform code styling for spans and blocks. */
  code: "\x1b[36m",
  /** Bold yellow — emphasized safety markers in prose. */
  safety: "\x1b[1;33m",
};

/** Safety markers emphasized in prose (bold). Deterministic, conservative. */
const SAFETY_TERMS = ["rejected", "hard error", "writes nothing", "cannot", "never"];

/** The home splash (brand palette), embedded for the compiled binary.
 *  Keep in sync with brand/splash-ansi.sh. */
const SPLASH =
  "\n" +
  "  \x1b[38;2;194;65;12m❯\x1b[0m\x1b[38;2;255;255;0m❯\x1b[0m \x1b[38;2;247;244;236mlq\x1b[0m\x1b[38;2;31;111;235m ▉\x1b[0m\n" +
  "\n";

/** Render a help page for stdout, honoring the `--rich` mode. */
export function renderPage(page: HelpPage, rich: RichMode): string {
  const richOn = rich === "always" || (rich === "auto" && Deno.stdout.isTerminal());
  return richOn ? renderPageRich(page) : renderPageText(page);
}

/** Deterministic plain-text rendering of a help page — the floor. */
export function renderPageText(page: HelpPage): string {
  const out: string[] = [];
  if (page.id !== "home") {
    const header = pageHeader(page);
    out.push(header);
    out.push("=".repeat(header.length));
  }

  for (let i = 0; i < page.sections.length; i++) {
    const section = page.sections[i];
    if (!(page.id === "home" && i === 0)) out.push("");
    if (section.heading.length > 0) {
      out.push(section.heading);
      out.push("-".repeat(section.heading.length));
    }
    out.push(toPlainText(section.body));
  }

  if (page.id === "home") appendHomeMap(out, (line) => line);
  appendFurtherReading(out, page, (line) => line);

  return out.join("\n") + "\n";
}

/** ANSI rendering of the same content; ANSI-stripped it equals `renderPageText`. */
export function renderPageRich(page: HelpPage): string {
  const out: string[] = [];
  if (page.id === "home") out.push(SPLASH);

  if (page.id !== "home") {
    const header = pageHeader(page);
    out.push(`${ANSI.heading}${header}${ANSI.reset}`);
    out.push("=".repeat(header.length));
  }

  for (let i = 0; i < page.sections.length; i++) {
    const section = page.sections[i];
    if (!(page.id === "home" && i === 0)) out.push("");
    if (section.heading.length > 0) {
      out.push(`${ANSI.heading}${section.heading}${ANSI.reset}`);
      out.push("-".repeat(section.heading.length));
    }
    out.push(toStyledText(section.body));
  }

  if (page.id === "home") appendHomeMap(out, (line) => styleCodeSpan(line));
  appendFurtherReading(out, page, (line) => styleCodeSpan(line));

  return out.join("\n") + "\n";
}

/** The home page map (generated from the catalog), each line via `emit`. */
function appendHomeMap(out: string[], emit: (line: string) => string): void {
  out.push("");
  out.push(emit("Pages"));
  out.push("-".repeat("Pages".length));
  const groups = groupedPages();
  const maxReach = Math.max(
    ...groups.flatMap((g) => g.pages.map((p) => reachOf(p.id).length)),
  );
  for (const group of groups) {
    out.push(emit(`${group.group}/`));
    for (const p of group.pages) {
      out.push(emit(`  ${reachOf(p.id).padEnd(maxReach)}    lq help ${reachOf(p.id)}`));
    }
  }
}

/** The further-reading list, each line via `emit`. */
function appendFurtherReading(out: string[], page: HelpPage, emit: (line: string) => string): void {
  if (page.furtherReading.length === 0) return;
  out.push("");
  out.push(emit("Further reading"));
  out.push("-".repeat("Further reading".length));
  for (const link of page.furtherReading) {
    out.push(emit(`  lq help ${reachOf(link.page)} - ${link.hint}`));
  }
}

/** The page header line, e.g. "lq read" for commands, "lq help cst" for topics. */
function pageHeader(page: HelpPage): string {
  if (page.id === "home") return "lq";
  const reach = reachOf(page.id);
  return page.id.startsWith("commands/") ? `lq ${reach}` : `lq help ${reach}`;
}

/** Strip code markers for plain-text output: drop fence lines and inline backticks. */
function toPlainText(body: string): string {
  return body
    .split("\n")
    .filter((line) => !/^\s*```/.test(line))
    .join("\n")
    .replace(/`/g, "");
}

/** Style a body for rich output: code blocks in code color, inline code and safety markers styled. */
function toStyledText(body: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const rawLine of body.split("\n")) {
    if (/^\s*```/.test(rawLine)) {
      inBlock = !inBlock;
      continue;
    }
    if (inBlock) {
      out.push(`${ANSI.code}${rawLine}${ANSI.reset}`);
      continue;
    }
    out.push(styleInline(rawLine));
  }
  return out.join("\n");
}

/** Style one non-code line: backtick spans in code color, safety terms bold. */
function styleInline(line: string): string {
  const parts = line.split("`");
  let out = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) out += `${ANSI.code}${parts[i]}${ANSI.reset}`;
    else out += emphasizeSafety(parts[i]);
  }
  return out;
}

/** Bold the safety markers in prose (deterministic, self-closed runs). */
function emphasizeSafety(text: string): string {
  let out = text;
  for (const term of SAFETY_TERMS) {
    if (out.includes(term)) {
      out = out.replaceAll(term, `${ANSI.safety}${term}${ANSI.reset}`);
    }
  }
  return out;
}

/** Wrap the `lq help <page>` fragment in a line with the code color. */
function styleCodeSpan(line: string): string {
  return line.replace(/(lq help \S+)/g, `${ANSI.code}$1${ANSI.reset}`);
}
