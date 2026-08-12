/**
 * help_render.ts — renderers for the built-in help.
 *
 * The text renderer is the deterministic floor: no width assumptions, no
 * color, readable when redirected. The rich renderer (Phase 3) is a safe ANSI
 * subset: colored headings, emphasized safety markers, uniform code styling,
 * and the home splash logo.
 */
import { groupedPages, reachOf, type HelpPage } from "./help.ts";

/** `--rich` value: `auto` adapts to terminal interactivity. */
export type RichMode = "auto" | "always" | "never";

/** Render a help page for stdout, honoring the `--rich` mode. */
export function renderPage(page: HelpPage, rich: RichMode): string {
  // Phase 3 replaces this with rich rendering for interactive terminals;
  // the deterministic text floor is the output for now.
  return renderPageText(page);
}

/** Deterministic plain-text rendering of a help page — the floor. */
export function renderPageText(page: HelpPage): string {
  const out: string[] = [];
  const header = pageHeader(page);
  out.push(header);
  out.push("=".repeat(header.length));

  for (const section of page.sections) {
    out.push("");
    out.push(section.heading);
    out.push("-".repeat(section.heading.length));
    out.push(toPlainText(section.body));
  }

  if (page.id === "home") {
    out.push("");
    out.push("Pages");
    out.push("-----");
    for (const group of groupedPages()) {
      out.push(`${group.group}/`);
      for (const p of group.pages) {
        out.push(`  ${reachOf(p.id)}    lq help ${reachOf(p.id)}`);
      }
    }
  }

  if (page.furtherReading.length > 0) {
    out.push("");
    out.push("Further reading");
    out.push("---------------");
    for (const link of page.furtherReading) {
      out.push(`  lq help ${reachOf(link.page)} - ${link.hint}`);
    }
  }

  return out.join("\n") + "\n";
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
