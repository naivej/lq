import type { Node, BlockNode } from "./ast.ts";

export interface TextSegment {
  /** Index of this text node in the children array that owns it */
  childIndex: number;
  /** The text content of this node */
  text: string;
  /** The children array containing this node at `childIndex` — set when
   *  `recurseLayouts` is used, so `split-after` can splice into the list the
   *  text actually lives in (a match may sit in a nested layout, e.g. inside a
   *  Foot inset's Plain Layout — test_report_38 F3). */
  owner?: Node[];
}

/**
 * Advance LyX's flat-model change depths when a change marker is encountered.
 * LyX keeps one active Change per position (dev log 84 F1): a different-type
 * opener terminates any open region of the other type (the opposite depth is
 * zeroed), and a closer decrements whichever depth is open. Every marker
 * walker routes its depth bookkeeping through this single implementation so
 * the rule lives in one place (code_review_85-74 Standards-3).
 */
export function advanceChangeDepths(
  key: string,
  deletedDepth: number,
  insertedDepth: number,
): { deletedDepth: number; insertedDepth: number } {
  if (key === "change_deleted") return { deletedDepth: deletedDepth + 1, insertedDepth: 0 };
  if (key === "change_inserted") return { deletedDepth: 0, insertedDepth: insertedDepth + 1 };
  // \change_unchanged: close whichever region is open
  if (insertedDepth > 0) return { deletedDepth, insertedDepth: insertedDepth - 1 };
  if (deletedDepth > 0) return { deletedDepth: deletedDepth - 1, insertedDepth };
  return { deletedDepth, insertedDepth };
}

/**
 * Build a concatenated view of text children, skipping text inside
 * \change_deleted blocks. Change tracking markers (change_deleted,
 * change_inserted, change_unchanged) are transparent — they don't
 * break concatenation. Only structural children (insets, nested
 * layouts) act as implicit boundaries (detected via childIndex gaps).
 *
 * With `opts.recurseLayouts`, text is also collected from nested `layout`
 * blocks (descending through `inset` blocks like `Foot` to reach them), so
 * `split-after` can target text inside a footnote (test_report_38 F3). Text is
 * collected only under a layout container — inset metadata (a Foot `status`
 * line, a CommandInset `name "…"` line) is not matchable. Each segment then
 * carries its owning children list (`owner`).
 */
export function concatenateTextNodes(
  children: Node[],
  opts?: { recurseLayouts?: boolean; topLevelIsLayout?: boolean; includeDeleted?: boolean },
): { segments: TextSegment[]; fullText: string } {
  const segments: TextSegment[] = [];
  const recurse = opts?.recurseLayouts ?? false;
  const topLevelIsLayout = opts?.topLevelIsLayout ?? true;
  const includeDeleted = opts?.includeDeleted ?? false;

  function walk(list: Node[], collectText: boolean): void {
    // Change markers are per-layout (per paragraph), so each nested level
    // starts with a fresh depth context.
    let deletedDepth = 0;
    for (let i = 0; i < list.length; i++) {
      const child = list[i];
      if (child.type === "property") {
        const k = child.key;
        if (k === "change_deleted" || k === "change_inserted" || k === "change_unchanged") {
          deletedDepth = advanceChangeDepths(k, deletedDepth, 0).deletedDepth;
        }
      } else if (child.type === "text") {
        // includeDeleted: selectors (e.g. :contains) see ALL text — a phrase
        // inside \change_deleted still locates its node (dev log 87 D7).
        // Mutations (--find / split-after) keep skipping deleted text.
        if (collectText && (includeDeleted || deletedDepth === 0)) {
          if (recurse) {
            segments.push({ childIndex: i, text: child.text, owner: list });
          } else {
            segments.push({ childIndex: i, text: child.text });
          }
        }
      } else if (child.type === "block" && recurse) {
        const b = child as BlockNode;
        if (b.tag === "layout") {
          walk(b.children, true); // collect text under nested layouts
        } else if (b.tag === "inset") {
          // Descend through insets to reach their nested layouts, but do NOT
          // collect inset metadata text (e.g. a CommandInset label line).
          walk(b.children, false);
        }
      }
    }
  }
  walk(children, topLevelIsLayout);

  const fullText = segments.map(s => s.text).join("");
  return { segments, fullText };
}

/** Map a position in the concatenated fullText to (segmentIndex, offsetInSegment). */
export function mapPosToSegment(segments: TextSegment[], pos: number): { segIdx: number; offset: number } {
  let remaining = pos;
  for (let i = 0; i < segments.length; i++) {
    if (remaining < segments[i].text.length) return { segIdx: i, offset: remaining };
    remaining -= segments[i].text.length;
  }
  const last = segments[segments.length - 1];
  return { segIdx: segments.length - 1, offset: last.text.length };
}
