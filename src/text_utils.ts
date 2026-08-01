import type { Node } from "./ast.ts";

export interface TextSegment {
  /** Index of this text node in the original children array */
  childIndex: number;
  /** The text content of this node */
  text: string;
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
 */
export function concatenateTextNodes(children: Node[]): { segments: TextSegment[]; fullText: string } {
  const segments: TextSegment[] = [];
  let deletedDepth = 0;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === "property") {
      const k = child.key;
      if (k === "change_deleted" || k === "change_inserted" || k === "change_unchanged") {
        deletedDepth = advanceChangeDepths(k, deletedDepth, 0).deletedDepth;
      }
    } else if (child.type === "text") {
      if (deletedDepth === 0) {
        segments.push({ childIndex: i, text: child.text });
      }
    }
  }

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
