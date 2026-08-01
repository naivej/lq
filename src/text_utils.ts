import type { Node } from "./ast.ts";

export interface TextSegment {
  /** Index of this text node in the original children array */
  childIndex: number;
  /** The text content of this node */
  text: string;
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
      if (child.key === "change_deleted") {
        deletedDepth++;
      } else if (child.key === "change_inserted") {
        // LyX's flat model: a \change_inserted opener terminates any open
        // deleted run (one active Change per position — dev log 84 F1).
        deletedDepth = 0;
      } else if (child.key === "change_unchanged") {
        if (deletedDepth > 0) deletedDepth--;
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
