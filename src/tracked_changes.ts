/**
 * Tracked-change machinery for LyX's flat change model.
 *
 * LyX stores one Change per text position (never nested) and emits
 * \change_inserted / \change_deleted / \change_unchanged markers on state
 * transitions. This module owns everything that creates, detects, flattens,
 * or annotates those markers: marker predicates, the author/tracking header,
 * output annotations, marker wrapping, post-mutation flattening, and
 * cross-node substring replacement. See dev logs 74–79 for the design.
 */
import { Node, BlockNode, DocumentNode, PropertyNode } from "./ast.ts";
import { concatenateTextNodes, mapPosToSegment, type TextSegment } from "./text_utils.ts";

/** Marker keys: \change_deleted / \change_inserted open a tracked region. */
export function isChangeOpener(key: string): boolean {
  return key === "change_deleted" || key === "change_inserted";
}

/** \change_unchanged closes a tracked region. */
export function isChangeCloser(key: string): boolean {
  return key === "change_unchanged";
}

// Resolve the author ID for the given author name.
// Reads existing \author entries from the .lyx header:
// - If the name matches an existing author, return its ID.
// - Otherwise, auto-assign a new ID (max existing + 1, or 1 if none exist)
//   and add a new \author entry to the header.

function getHeader(ast: DocumentNode): BlockNode | undefined {
  const doc = ast.children.find(c => c.type === "block" && c.tag === "document") as BlockNode | undefined;
  return doc?.children.find(c => c.type === "block" && c.tag === "header") as BlockNode | undefined;
}

// Returns the resolved author ID (always ≥ 0; returns 0 only when the
// document or header block is missing, which indicates a malformed .lyx file).
export function resolveAuthorId(ast: DocumentNode, authorName: string): number {
  const header = getHeader(ast);
  if (!header) return 0;

  // Parse existing \author <id> "<name>" entries
  let maxId = 0;
  for (const c of header.children) {
    if (c.type !== "property" || c.key !== "author" || !c.value) continue;
    const m = c.value.match(/^(\d+)\s+"(.+)"$/);
    if (!m) continue;
    const id = parseInt(m[1], 10);
    const name = m[2];
    if (name === authorName) return id;
    if (id > maxId) maxId = id;
  }

  // Not found — assign new ID
  const newId = maxId + 1;
  header.children.push({ type: "property", key: "author", value: `${newId} "${authorName}"` });
  return newId;
}

// Ensure \tracking_changes true is set in the header so LyX does not auto-accept
// tracked changes on file open. Without this, \change_deleted and \change_inserted
// markers are silently stripped by LyX.
export function ensureTrackingChangesInHeader(ast: DocumentNode): void {
  const header = getHeader(ast);
  if (!header) return;

  const existing = header.children.find((c: Node) => c.type === "property" && c.key === "tracking_changes") as PropertyNode | undefined;
  if (existing) {
    // Overwrite any existing value (e.g. false) to true
    existing.value = "true";
  } else {
    header.children.push({ type: "property", key: "tracking_changes", value: "true" });
  }
}

/** Annotate text nodes with their tracked-change status for debugging.
 *  Walks the CST with a change-depth tracker. Text nodes inside
 *  change_deleted get changeStatus="deleted", inside change_inserted get
 *  changeStatus="inserted". Returns a new object — the original is not mutated.
 *  Applied by default to `dump` and `read` (default mode) output. */
export function annotateChanges(root: Node | DocumentNode | Node[] | DocumentNode[]): unknown {
  // Handle arrays (multi-match selector results)
  if (Array.isArray(root)) return root.map(r => annotateChanges(r));

  function walk(node: Node | DocumentNode, deletedDepth: number, insertedDepth: number): unknown {
    if (node.type === "text") {
      const result: Record<string, unknown> = { type: "text", text: node.text };
      if (deletedDepth > 0) result.changeStatus = "deleted";
      else if (insertedDepth > 0) result.changeStatus = "inserted";
      return result;
    }
    if (node.type === "property") {
      return { type: "property", key: node.key, value: node.value };
    }
    if (node.type === "block") {
      const children: unknown[] = [];
      for (const child of node.children) {
        if (child.type === "property" && child.key === "change_deleted") {
          children.push({ type: "property", key: child.key, value: child.value });
          deletedDepth++;
        } else if (child.type === "property" && child.key === "change_inserted") {
          children.push({ type: "property", key: child.key, value: child.value });
          insertedDepth++;
        } else if (child.type === "property" && isChangeCloser(child.key)) {
          children.push({ type: "property", key: child.key, value: child.value });
          if (insertedDepth > 0) insertedDepth--; else if (deletedDepth > 0) deletedDepth--;
        } else {
          children.push(walk(child, deletedDepth, insertedDepth));
        }
      }
      return { type: "block", tag: node.tag, args: node.args, isBeginVariant: node.isBeginVariant, children };
    }
    // DocumentNode: recurse into children
    if (node.type === "document") {
      const children: unknown[] = [];
      for (const child of node.children) {
        children.push(walk(child, deletedDepth, insertedDepth));
      }
      return { type: "document", children };
    }
    return { type: (node as Node).type };
  }
  return walk(root, 0, 0);
}

/** Annotate text nodes with changeStatus in-place (mutates the tree).
 *  Used by `read` default mode to add annotations without changing
 *  the array/shape structure of the output. */
export function annotateChangesInPlace(node: Node, deletedDepth: number, insertedDepth: number): void {
  if (node.type === "text") {
    if (deletedDepth > 0) (node as unknown as Record<string, unknown>).changeStatus = "deleted";
    else if (insertedDepth > 0) (node as unknown as Record<string, unknown>).changeStatus = "inserted";
    return;
  }
  if (node.type === "block") {
    for (const child of node.children) {
      annotateChangesInPlace(child, deletedDepth, insertedDepth);
      // Depth tracking lives here — mutating primitives inside the
      // recursive call has no effect (pass-by-value), so depths are
      // updated in this loop scope after each child returns.
      if (child.type === "property") {
        if (child.key === "change_deleted") deletedDepth++;
        else if (child.key === "change_inserted") insertedDepth++;
        else if (isChangeCloser(child.key)) {
          if (insertedDepth > 0) insertedDepth--; else if (deletedDepth > 0) deletedDepth--;
        }
      }
    }
  }
}

/** Recursively extract text from a node's descendants.
 *  Insets emit their selector as a placeholder marker — we do NOT recurse
 *  into them.  This keeps body-text scans clean and prevents concatenation
 *  artifacts.  To see an inset's content, query the inset directly.
 *
 *  Track-change properties (change_deleted, change_inserted, change_unchanged)
 *  emit inline \change_*{} markers so the user can see pending edits at a
 *  glance.  The {} wrapper form is a deliberate simplification of LyX source
 *  syntax for readability — see dev log 45 for rationale. */
export function extractAllText(node: Node, maxLen = Infinity, inMarker = false): string {
  if (maxLen <= 0) return "";
  if (node.type === "text") return node.text.substring(0, maxLen);
  if (node.type === "property") {
    if (isChangeOpener(node.key)) {
      const close = inMarker ? "}" : "";
      const open = "\\" + node.key + "{";
      return (close + open).substring(0, maxLen);
    }
    if (isChangeCloser(node.key)) {
      return inMarker ? "}".substring(0, maxLen) : "";
    }
    return "";
  }
  if (node.type === "block") {
    if (node.tag === "inset") {
      const label = " inset[" + (node.args || "").trim() + "] ";
      return label.substring(0, maxLen);
    }
    let result = "";
    let markerOpen = inMarker;
    for (const child of node.children) {
      const remaining = maxLen - result.length;
      if (remaining <= 0) break;
      result += extractAllText(child, remaining, markerOpen);
      if (child.type === "property") {
        if (isChangeOpener(child.key)) markerOpen = true;
        else if (isChangeCloser(child.key)) markerOpen = false;
      }
    }
    return result;
  }
  return "";
}

/** Recursively check if children already contain pending tracked changes
 *  (change_deleted or change_inserted property nodes). Used to warn before
 *  re-editing a node that has not yet had its changes accepted/undone. */
export function hasTrackedChanges(children: Node[]): boolean {
  for (const c of children) {
    if (c.type === "property" && isChangeOpener(c.key)) {
      return true;
    }
    if (c.type === "block") {
      if (hasTrackedChanges((c as BlockNode).children)) return true;
    }
  }
  return false;
}

export function wrapInChangeMarkers(
  content: Node[], type: "inserted" | "deleted", authorId: number, ts: string
): Node[] {
  return [
    { type: "property", key: `change_${type}`, value: `${authorId} ${ts}` },
    ...content,
    { type: "property", key: "change_unchanged" },
  ];
}

/**
 * Flatten nested tracked-change markers in children into LyX's flat model.
 *
 * LyX uses one Change per position — nested \change_inserted or
 * \change_deleted inside \change_inserted is malformed. This function
 * post-processes children after a mutation to ensure flat, unnested markers.
 *
 * Rules (matching LyX's per-position Change model, dev log 78 Fix 1):
 * - \change_deleted inside \change_inserted: dropped entirely — deleting
 *   pending-inserted text removes it (it was never in the accepted document).
 * - \change_inserted inside \change_inserted, same author: merge — absorb
 *   the inner content into the outer block, timestamp becomes max(old, new).
 * - \change_inserted inside \change_inserted, different author: split into
 *   adjacent flat blocks (no \change_unchanged between them — LyX emits a
 *   marker only when the Change state differs — one closer at region end).
 * - Top-level \change_deleted regions pass through verbatim: their text is
 *   invisible to mutations, so they never acquire new nesting.
 */
export function flattenNestedChanges(children: Node[]): Node[] {
  const result: Node[] = [];

  const parseMarker = (value: string | undefined): { authorId: number; ts: string } => {
    const parts = value?.split(" ") ?? [];
    return { authorId: parseInt(parts[0], 10) || 0, ts: parts[1] || "0" };
  };

  // Collect the content of the change region opened by the marker at
  // `start - 1`: everything up to (excluding) the matching \change_unchanged.
  // Returns the content and the index of that closer.
  const collectRegion = (start: number): { content: Node[]; closer: number } => {
    const content: Node[] = [];
    let depth = 1;
    let j = start;
    while (j < children.length && depth > 0) {
      const n = children[j];
      if (n.type === "property" && isChangeOpener(n.key)) depth++;
      else if (n.type === "property" && isChangeCloser(n.key)) depth--;
      if (depth > 0) content.push(n);
      j++;
    }
    return { content, closer: j - 1 };
  };

  let i = 0;
  while (i < children.length) {
    const child = children[i];

    if (child.type === "property" && child.key === "change_deleted") {
      const { closer } = collectRegion(i + 1);
      for (let k = i; k <= closer && k < children.length; k++) result.push(children[k]);
      i = closer + 1;
      continue;
    }

    if (child.type === "property" && child.key === "change_inserted") {
      const outer = parseMarker(child.value);
      const { content, closer } = collectRegion(i + 1);

      // Split region content into flat segments: outer-author runs, and
      // different-author inner blocks. Same-author inners are absorbed.
      const segments: { authorId: number; ts: string; nodes: Node[] }[] = [];
      let outerRun: Node[] = [];
      let outerTs = outer.ts;
      const flushOuterRun = () => {
        if (outerRun.length > 0) {
          segments.push({ authorId: outer.authorId, ts: outerTs, nodes: outerRun });
          outerRun = [];
        }
      };

      let k = 0;
      while (k < content.length) {
        const n = content[k];
        if (n.type === "property" && isChangeOpener(n.key)) {
          const inner = parseMarker(n.value);
          // Find the inner region's extent within the outer content
          const innerContent: Node[] = [];
          let depth = 1;
          let m = k + 1;
          while (m < content.length && depth > 0) {
            const x = content[m];
            if (x.type === "property" && isChangeOpener(x.key)) depth++;
            else if (x.type === "property" && isChangeCloser(x.key)) depth--;
            if (depth > 0) innerContent.push(x);
            m++;
          }
          if (n.key === "change_inserted") {
            if (inner.authorId === outer.authorId) {
              if (parseInt(inner.ts, 10) > parseInt(outerTs, 10)) outerTs = inner.ts;
              outerRun.push(...innerContent);
            } else {
              flushOuterRun();
              segments.push({ authorId: inner.authorId, ts: inner.ts, nodes: innerContent });
            }
          }
          // change_deleted inside change_inserted: drop entirely
          k = m;
        } else {
          outerRun.push(n);
          k++;
        }
      }
      flushOuterRun();

      for (const seg of segments) {
        result.push({ type: "property", key: "change_inserted", value: `${seg.authorId} ${seg.ts}` }, ...seg.nodes);
      }
      if (segments.length > 0) result.push({ type: "property", key: "change_unchanged" });
      i = closer + 1;
      continue;
    }

    result.push(child);
    i++;
  }

  return result;
}

export function wrapWithTracking(nodes: Node[], type: "inserted" | "deleted", authorId: number, ts?: string): Node[] {
  const trackingTs = ts ?? Math.floor(Date.now() / 1000).toString();

  const result: Node[] = [];
  // Buffer consecutive text nodes to wrap them under a single change marker pair,
  // reducing verbosity when a layout contains many text fragments.
  let textBuffer: Node[] = [];

  function flushTextBuffer() {
    if (textBuffer.length > 0) {
      result.push(...wrapInChangeMarkers(textBuffer, type, authorId, trackingTs));
      textBuffer = [];
    }
  }

  for (const n of nodes) {
    if (n.type === "text") {
      textBuffer.push(n);
    } else {
      flushTextBuffer();
      if (n.type === "block") {
        const b = n as BlockNode;
        if (b.tag === "layout") {
          b.children = wrapWithTracking(b.children, type, authorId, trackingTs);
          result.push(b);
        } else if (b.tag === "inset") {
          result.push(...wrapInChangeMarkers([b], type, authorId, trackingTs));
        } else {
          result.push(b);
        }
      } else {
        result.push(n);
      }
    }
  }
  flushTextBuffer();
  return result;
}

// --- Cross-text-node substring matching utilities ---

/** Detect whether a block child (inset) sits between two matched segments.
 *  Such a match crosses a structural boundary and is silently skipped —
 *  it behaves as if findStr didn't match there. */
function segmentsCrossInset(children: Node[], segA: TextSegment, segB: TextSegment): boolean {
  for (let i = segA.childIndex + 1; i < segB.childIndex; i++) {
    if (children[i].type === "block") return true;
  }
  return false;
}

/**
 * Straddle detection: do two matched segments lie on opposite sides of a
 * tracked-change boundary (one inside \change_inserted, the other in
 * original text)? Such a match is invalid — LyX's flat model can't
 * represent a single edit spanning both regions (dev log 78 Fix 1).
 * Segments never reference \change_deleted text (concatenateTextNodes
 * skips it), so only the inserted state needs tracking.
 */
function straddlesChangeBoundary(children: Node[], segA: TextSegment, segB: TextSegment): boolean {
  let insideInserted = false;
  let aInsideInserted: boolean | null = null;

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    if (child.type === "property") {
      if (child.key === "change_inserted") insideInserted = true;
      else if (isChangeCloser(child.key)) insideInserted = false;
      continue;
    }
    if (child.type !== "text") continue;

    if (i === segA.childIndex) aInsideInserted = insideInserted;
    if (i === segB.childIndex) return aInsideInserted !== insideInserted;
  }
  return false; // safety: if we can't determine, allow the match
}

/**
 * Core cross-node substring replacement. Concatenates all non-deleted text
 * children, finds all occurrences of findStr, and rebuilds the children array
 * with matched portions split out and (if tracked) wrapped in change markers.
 *
 * Matches that cross a structural boundary (inset between text nodes) are
 * silently skipped. Matches that straddle a tracked-change boundary are
 * skipped too, but reported via straddleCount so the caller can emit the
 * dedicated error (dev log 78) instead of the generic NO_MATCH.
 */
export function applyCrossNodeReplace(
  children: Node[],
  findStr: string,
  newValue: string,
  tracked: boolean,
  authorId: number,
  ts: string,
): { newChildren: Node[]; matchCount: number; straddleCount: number } {
  const { segments, fullText } = concatenateTextNodes(children);
  if (segments.length === 0 || fullText.length === 0) {
    return { newChildren: [...children], matchCount: 0, straddleCount: 0 };
  }

  // Find all match positions in the concatenated text
  const matchStarts: number[] = [];
  let pos = 0;
  while ((pos = fullText.indexOf(findStr, pos)) !== -1) {
    matchStarts.push(pos);
    pos += findStr.length;
  }
  if (matchStarts.length === 0) return { newChildren: [...children], matchCount: 0, straddleCount: 0 };

  // Build a boolean array: isMatched[i] = true if character i is inside a valid match
  const isMatched = new Array(fullText.length).fill(false);
  let validCount = 0;
  let straddleCount = 0;
  for (const ms of matchStarts) {
    const me = ms + findStr.length;
    const s = mapPosToSegment(segments, ms);
    // Use me-1 (last matched character) so a match ending at a segment
    // boundary doesn't map to the next segment and falsely check for
    // blocks beyond the actual match range.
    const e = mapPosToSegment(segments, me > 0 ? me - 1 : 0);
    if (segmentsCrossInset(children, segments[s.segIdx], segments[e.segIdx])) continue;
    // Straddle check: match must not cross a \change_unchanged boundary
    // between tracked and original text (dev log 78 Fix 1).
    if (straddlesChangeBoundary(children, segments[s.segIdx], segments[e.segIdx])) {
      straddleCount++;
      continue;
    }
    for (let p = ms; p < me; p++) isMatched[p] = true;
    validCount++;
  }
  if (validCount === 0) return { newChildren: [...children], matchCount: 0, straddleCount };

  // Rebuild children array: iterate original children, splitting text nodes
  // at match boundaries and collecting matched portions into tracking blocks.
  const result: Node[] = [];
  let concatPos = 0; // cursor in the concatenated fullText
  let segIdx = 0;    // current segment index
  let matchedBuffer: Node[] = [];
  let inMatch = false;

  function flushMatched() {
    if (matchedBuffer.length === 0) return;
    if (tracked) {
      result.push(...wrapInChangeMarkers(matchedBuffer, "deleted", authorId, ts));
      result.push(...wrapInChangeMarkers([{ type: "text", text: newValue }], "inserted", authorId, ts));
    } else {
      result.push({ type: "text", text: newValue });
    }
    matchedBuffer = [];
    inMatch = false;
  }

  for (let i = 0; i < children.length; i++) {
    const child = children[i];

    // Is this child a text segment in the concatenation?
    if (segIdx < segments.length && segments[segIdx].childIndex === i) {
      const seg = segments[segIdx];
      const segStart = concatPos;
      const segText = seg.text;

      // DL81 (test_report_34 Finding 2): for UNTRACKED matches entirely within
      // a single text node, replace in place so the node — and thus its
      // serialized line — stays intact. Splitting e.g. `name "sec:Section_label"`
      // into three nodes serializes to three lines, which LyX rejects. A matched
      // run of exactly findStr.length within one segment is a complete match
      // (a cross-node match's per-segment part is always shorter).
      let inPlaceText: string | null = null;
      let needsStandardPath = false;
      {
        let k = 0;
        while (k < segText.length) {
          const gp = segStart + k;
          if (isMatched[gp]) {
            let re = k;
            while (re < segText.length && isMatched[segStart + re]) re++;
            if (tracked || (re - k) !== findStr.length) {
              needsStandardPath = true;
              break;
            }
            inPlaceText = (inPlaceText === null ? segText.substring(0, k) : inPlaceText) + newValue;
            k = re;
          } else {
            let re = k;
            while (re < segText.length && !isMatched[segStart + re]) re++;
            if (inPlaceText !== null) inPlaceText += segText.substring(k, re);
            k = re;
          }
        }
      }

      if (!needsStandardPath && inPlaceText !== null) {
        // In-place: this segment had only complete single-segment matches.
        result.push({ type: "text", text: inPlaceText });
      } else {
        // Existing standard (split) path: matches that cross nodes or are
        // tracked still split at match boundaries.
        let charIdx = 0;
        while (charIdx < segText.length) {
          const globalPos = segStart + charIdx;

          if (isMatched[globalPos]) {
            // Find end of this matched run within the segment
            let runEnd = charIdx;
            while (runEnd < segText.length && isMatched[segStart + runEnd]) runEnd++;
            matchedBuffer.push({ type: "text", text: segText.substring(charIdx, runEnd) });
            inMatch = true;
            charIdx = runEnd;
          } else {
            if (inMatch) flushMatched();
            // Find end of this unmatched run
            let runEnd = charIdx;
            while (runEnd < segText.length && !isMatched[segStart + runEnd]) runEnd++;
            result.push({ type: "text", text: segText.substring(charIdx, runEnd) });
            charIdx = runEnd;
          }
        }
      }

      concatPos += segText.length;
      segIdx++;
    } else {
      // Non-segment child (property, block, or deleted text)
      // Flush matched buffer before a block boundary
      if (inMatch && child.type === "block") flushMatched();
      result.push(child);
    }
  }

  // Flush any trailing matched text
  if (inMatch) flushMatched();

  return { newChildren: result, matchCount: validCount, straddleCount };
}
