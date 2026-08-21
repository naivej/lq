/** Pure outline nesting + LyX-source heading scan (no vscode import — unit-testable). */

export interface OutlineEntryLike {
  level: number;
  number: string;
  text: string;
  id: string;
  /** 0-based line in the .lyx buffer when known. */
  line?: number;
}

export interface NestedOutline {
  entry: OutlineEntryLike;
  name: string;
  children: NestedOutline[];
}

export function nestOutlineEntries(entries: OutlineEntryLike[]): NestedOutline[] {
  const roots: NestedOutline[] = [];
  const stack: NestedOutline[] = [];
  for (const e of entries) {
    const name = e.number ? `${e.number} ${e.text}`.trim() : e.text || e.id;
    const node: NestedOutline = { entry: e, name, children: [] };
    while (stack.length > 0) {
      const top = stack[stack.length - 1];
      if (!top || top.entry.level < e.level) break;
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (!parent) roots.push(node);
    else parent.children.push(node);
    stack.push(node);
  }
  return roots;
}

const LAYOUT_LEVEL: Record<string, number> = {
  Part: -1,
  Chapter: 0,
  Section: 1,
  "Section*": 1,
  Subsection: 2,
  "Subsection*": 2,
  Subsubsection: 3,
  "Subsubsection*": 3,
  Paragraph: 4,
  Subparagraph: 5,
};

/**
 * Scan raw .lyx buffer lines for heading layouts. Used when Live outline is
 * unavailable (old lq) and to attach real line numbers for the Outline view.
 */
export function scanLyxHeadingLines(lines: string[]): OutlineEntryLike[] {
  const out: OutlineEntryLike[] = [];
  let i = 0;
  while (i < lines.length) {
    const m = /^\\begin_layout\s+(\S+)\s*$/.exec(lines[i] ?? "");
    if (!m) {
      i++;
      continue;
    }
    const layout = m[1];
    if (!layout) {
      i++;
      continue;
    }
    const level = LAYOUT_LEVEL[layout];
    if (level === undefined) {
      i++;
      continue;
    }
    const startLine = i;
    i++;
    const parts: string[] = [];
    let depth = 0;
    while (i < lines.length) {
      const line = lines[i] ?? "";
      if (/^\\begin_inset\b/.test(line)) depth++;
      if (/^\\end_inset\s*$/.test(line) && depth > 0) {
        depth--;
        i++;
        continue;
      }
      if (depth === 0 && /^\\end_layout\s*$/.test(line)) break;
      if (depth === 0 && line.trim() && !line.startsWith("\\")) {
        parts.push(line.trim());
      }
      // Short-title Argument text is skipped (inside inset depth).
      i++;
    }
    const text = parts.join(" ").replace(/\s+/g, " ").trim();
    if (text) {
      const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
      out.push({
        level,
        number: "",
        text,
        id: `sec-${slug || "x"}`,
        line: startLine,
      });
    }
    i++;
  }
  return out;
}

/** Attach approximate 0-based lines by searching for each entry's text in order. */
export function attachApproxLines(
  entries: OutlineEntryLike[],
  lines: string[],
): OutlineEntryLike[] {
  let from = 0;
  return entries.map((e) => {
    if (typeof e.line === "number") return e;
    const needle = e.text.trim();
    if (!needle) return { ...e, line: Math.min(from, Math.max(0, lines.length - 1)) };
    for (let i = from; i < lines.length; i++) {
      if ((lines[i] ?? "").includes(needle)) {
        from = i + 1;
        return { ...e, line: i };
      }
    }
    return { ...e, line: Math.min(from, Math.max(0, lines.length - 1)) };
  });
}

/** Best outline id whose heading line is at or above `line` (0-based). */
export function outlineIdForLine(
  entries: OutlineEntryLike[],
  lines: string[],
  line: number,
): string | undefined {
  const withLines = attachApproxLines(entries, lines);
  let best: OutlineEntryLike | undefined;
  for (const e of withLines) {
    if (typeof e.line !== "number") continue;
    if (e.line <= line) best = e;
    else break;
  }
  return best?.id;
}

export interface NavEntryLike {
  kind: string;
  number: string;
  text: string;
  id: string;
  name?: string;
  line?: number;
}

export interface NavigateLike {
  figures: NavEntryLike[];
  tables: NavEntryLike[];
  equations: NavEntryLike[];
  labels: NavEntryLike[];
  listings: NavEntryLike[];
  algorithms: NavEntryLike[];
}

function findForward(
  lines: string[],
  from: number,
  pred: (line: string, i: number) => boolean,
): number {
  for (let i = from; i < lines.length; i++) {
    if (pred(lines[i] ?? "", i)) return i;
  }
  return -1;
}

function attachList(
  entries: NavEntryLike[],
  locate: (e: NavEntryLike, from: number) => number,
): NavEntryLike[] {
  let from = 0;
  return entries.map((e) => {
    if (typeof e.line === "number") {
      from = Math.max(from, e.line + 1);
      return e;
    }
    const at = locate(e, from);
    if (at >= 0) {
      from = at + 1;
      return { ...e, line: at };
    }
    return e;
  });
}

/**
 * Drop Labels that already appear under Figures / Tables / Equations / listings / algorithms.
 * Safety net when Live data is stale or unfiltered.
 *
 * Do not drop solely because `text` matches an Outline heading — leftover body labels often
 * inherited the enclosing section title before Live stopped doing that, which hid real Labels.
 */
export function dedupeNavigateLabels(
  navigate: NavigateLike,
  _outline: OutlineEntryLike[],
): NavigateLike {
  const eqNames = new Set(
    navigate.equations.map((e) => e.name).filter((n): n is string => !!n),
  );
  const eqIds = new Set(navigate.equations.map((e) => e.id));
  const floatIds = new Set(
    [...navigate.figures, ...navigate.tables, ...navigate.listings, ...navigate.algorithms]
      .map((e) => e.id),
  );
  const floatTexts = new Set(
    [...navigate.figures, ...navigate.tables, ...navigate.listings, ...navigate.algorithms]
      .map((e) => e.text.trim())
      .filter(Boolean),
  );
  const floatNums = new Set(
    [...navigate.figures, ...navigate.tables, ...navigate.listings, ...navigate.algorithms]
      .map((e) => e.number.trim())
      .filter(Boolean),
  );
  const labels = navigate.labels.filter((l) => {
    if (l.name && eqNames.has(l.name)) return false;
    if (eqIds.has(l.id) || floatIds.has(l.id)) return false;
    const title = l.text.trim();
    if (title && floatTexts.has(title)) return false;
    // Bare numbered float markers with no extra title.
    if (!title && l.number.trim() && floatNums.has(l.number.trim())) return false;
    return true;
  });
  return { ...navigate, labels };
}

/**
 * Attach 0-based .lyx buffer lines so LyX Navigate can jump the text editor
 * for figures/tables/equations/labels (not only Outline headings).
 */
export function attachNavigateLines(
  navigate: NavigateLike,
  lines: string[],
): NavigateLike {
  const floatLocate = (insetNeedle: string) =>
    (e: NavEntryLike, from: number) => {
      const caption = e.text.trim();
      if (caption) {
        const byText = findForward(lines, from, (ln) => ln.includes(caption));
        if (byText >= 0) return byText;
      }
      return findForward(
        lines,
        from,
        (ln) => ln.includes(`\\begin_inset Float ${insetNeedle}`) ||
          ln.includes(`\\begin_inset Wrap ${insetNeedle}`),
      );
    };

  const figures = attachList(navigate.figures, floatLocate("figure"));
  const tables = attachList(navigate.tables, floatLocate("table"));
  const listings = attachList(navigate.listings, (_e, from) =>
    findForward(lines, from, (ln) => ln.includes("\\begin_inset listings"))
  );
  const algorithms = attachList(navigate.algorithms, floatLocate("algorithm"));

  const equations = attachList(navigate.equations, (e, from) => {
    if (e.name) {
      // Prefer the \\label{name} inside Formula, else CommandInset label name.
      const needleLabel = `\\label{${e.name}}`;
      const byTex = findForward(lines, from, (ln) => ln.includes(needleLabel));
      if (byTex >= 0) return byTex;
      const byInset = findForward(lines, from, (ln, i) => {
        if (!ln.includes("CommandInset label")) return false;
        const next = `${lines[i + 1] ?? ""}\n${lines[i + 2] ?? ""}\n${lines[i + 3] ?? ""}`;
        return next.includes(`name "${e.name}"`);
      });
      if (byInset >= 0) return byInset;
    }
    return findForward(lines, from, (ln) => ln.includes("\\begin_inset Formula"));
  });

  const labels = attachList(navigate.labels, (e, from) => {
    const name = e.name?.trim();
    if (!name) return -1;
    return findForward(lines, from, (ln, i) => {
      if (!ln.includes("CommandInset label")) return false;
      for (let j = i; j < Math.min(i + 8, lines.length); j++) {
        if ((lines[j] ?? "").includes(`name "${name}"`)) return true;
      }
      return false;
    });
  });

  return { figures, tables, equations, labels, listings, algorithms };
}
