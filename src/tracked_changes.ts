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
import {
  advanceChangeDepths,
  advanceTraversalState,
  concatenateTextNodes,
  createTraversalState,
  enterTraversalState,
  mapPosToSegment,
  traversalChange,
  traversalRegion,
  type TextSegment,
  type TraversalState,
} from "./text_utils.ts";
import { isInlineStyleKey } from "./registry.ts";
import type { ScopePredicate } from "./query.ts";

/** Marker keys: \change_deleted / \change_inserted open a tracked region. */
export function isChangeOpener(key: string): boolean {
  return key === "change_deleted" || key === "change_inserted";
}

/** \change_unchanged closes a tracked region. */
export function isChangeCloser(key: string): boolean {
  return key === "change_unchanged";
}

/**
 * Parse a change marker value ("<authorId> <ts>") into its parts. Shared by
 * flattenNestedChanges, applyCrossNodeReplace, and the undo replay scanner so
 * the marker format contract lives in one place (code_review_88-74 Standards-1).
 */
export function parseChangeMarker(value: string | undefined): { authorId: number; ts: string } {
  const parts = value?.split(" ") ?? [];
  return { authorId: parseInt(parts[0], 10) || 0, ts: parts[1] || "0" };
}

/**
 * Scan for the end of the change region opened by the marker at `start - 1`.
 *
 * `terminateAtDifferentType = false` (flatten / cross-node replace): the
 * region ends at the matching \change_unchanged that brings the open-region
 * depth back to 0; nested openers are counted.
 *
 * `terminateAtDifferentType = true` (replay undo): LyX's flat model ends a
 * region at the first \change_unchanged OR at the first different-type opener
 * (one active Change per position — dev log 84 F1), whichever comes first;
 * no nesting is possible in flat input.
 *
 * Returns the closer index (or -1) and the different-type opener index (or -1).
 */
export function scanRegionEnd(
  children: Node[],
  start: number,
  markerKey: string,
  terminateAtDifferentType: boolean,
): { closer: number; nextOpener: number } {
  let depth = 1;
  for (let j = start; j < children.length; j++) {
    const n = children[j];
    if (n.type !== "property") continue;
    if (isChangeOpener(n.key)) {
      if (terminateAtDifferentType && n.key !== markerKey) {
        return { closer: -1, nextOpener: j };
      }
      depth++;
    } else if (isChangeCloser(n.key)) {
      if (terminateAtDifferentType) return { closer: j, nextOpener: -1 };
      depth--;
      if (depth === 0) return { closer: j, nextOpener: -1 };
    }
  }
  return { closer: -1, nextOpener: -1 };
}

// Resolve the author ID for the given author name.
// Reads existing \author entries from the .lyx header:
// - If the name matches an existing author, return its ID.
// - Otherwise, auto-assign a new ID (max existing + 1, or 1 if none exist)
//   and add a new \author entry to the header.

export function getHeader(ast: DocumentNode): BlockNode | undefined {
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
 *  Applied by default to `dump` output; `read` uses `annotateChangesInPlace`
 *  to keep the output's array/shape structure. */
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
        if (child.type === "property" && (isChangeOpener(child.key) || isChangeCloser(child.key))) {
          children.push({ type: "property", key: child.key, value: child.value });
          // LyX's flat model (one active Change per position): a different-type
          // opener terminates any open region of the other type — dev log 84 F1.
          const depths = advanceChangeDepths(child.key, deletedDepth, insertedDepth);
          deletedDepth = depths.deletedDepth;
          insertedDepth = depths.insertedDepth;
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
      // updated in this loop scope after each child returns. The flat-model
      // rule (a different-type opener terminates any open region of the other
      // type — dev log 84 F1) is shared via advanceChangeDepths.
      if (child.type === "property" && (isChangeOpener(child.key) || isChangeCloser(child.key))) {
        const depths = advanceChangeDepths(child.key, deletedDepth, insertedDepth);
        deletedDepth = depths.deletedDepth;
        insertedDepth = depths.insertedDepth;
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

  // Collect the content of the change region opened by the marker at
  // `start - 1`, under LyX's flat model (dev log 90): a different-type opener
  // terminates the open region (one active Change per position), so the region
  // extends until the matching \change_unchanged OR the first different-type
  // opener, whichever comes first. `closer` is the \change_unchanged index
  // (or -1); `end` is where the region stops (the closer, or the different-type
  // opener to be reprocessed at the top level, or children.length).
  const collectRegion = (
    start: number,
    markerKey: string,
  ): { content: Node[]; end: number; closer: number } => {
    const { closer: found, nextOpener } = scanRegionEnd(children, start, markerKey, true);
    let end: number;
    let closer = -1;
    if (found !== -1) {
      end = found;
      closer = found;
    } else if (nextOpener !== -1) {
      end = nextOpener;
    } else {
      end = children.length;
    }
    const content: Node[] = [];
    for (let j = start; j < end; j++) content.push(children[j]);
    return { content, end, closer };
  };

  let i = 0;
  while (i < children.length) {
    const child = children[i];

    if (child.type === "property" && child.key === "change_deleted") {
      const { content, closer } = collectRegion(i + 1, "change_deleted");
      result.push(child);
      result.push(...content);
      if (closer !== -1) {
        result.push(children[closer]); // the matching \change_unchanged
        i = closer + 1;
      } else {
        // Ends at a different-type opener (reprocess it) or at end of list.
        i = i + 1 + content.length;
      }
      continue;
    }

    if (child.type === "property" && child.key === "change_inserted") {
      const outer = parseChangeMarker(child.value);
      const { content, end, closer } = collectRegion(i + 1, "change_inserted");

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
          const inner = parseChangeMarker(n.value);
          // Find the inner region's extent within the outer content
          const { closer } = scanRegionEnd(content, k + 1, n.key, false);
          const innerContent: Node[] = [];
          const end = closer === -1 ? content.length : closer;
          for (let p = k + 1; p < end; p++) innerContent.push(content[p]);
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
          k = closer === -1 ? content.length : closer + 1;
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
      i = closer !== -1 ? closer + 1 : end;
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
 * Is the whole buffer range [ms, me) inside the mutation scope? The scope is
 * the selector's state-predicate combination (dev log 92 §2.4/E2): every
 * overlapping segment's (region, active property values) must satisfy the
 * predicate. Undefined scope = see all text by default (dev log 90).
 */
function matchInScope(
  segments: TextSegment[],
  segRegions: { deleted: boolean; inserted: boolean; author: number; props: Record<string, string | undefined> }[],
  ms: number,
  me: number,
  scope: ScopePredicate,
): boolean {
  let offset = 0;
  for (let j = 0; j < segments.length; j++) {
    const segStart = offset;
    const segEnd = offset + segments[j].text.length;
    if (segEnd > ms && segStart < me) {
      const region: "current" | "inserted" | "deleted" = segRegions[j].deleted
        ? "deleted"
        : segRegions[j].inserted
        ? "inserted"
        : "current";
      if (!scope(region, segRegions[j].props)) return false;
    }
    offset = segEnd;
  }
  return true;
}

/**
 * Does the buffer range [ms, me) in the concatenated text overlap any segment
 * that sits inside a \change_deleted region? Used to count matches that touch
 * rejected text, so the caller can warn (dev log 90 §5.7).
 */
function rangeTouchesDeleted(
  segments: TextSegment[],
  segRegions: { deleted: boolean; inserted: boolean; author: number }[],
  ms: number,
  me: number,
): boolean {
  let offset = 0;
  for (let j = 0; j < segments.length; j++) {
    const segStart = offset;
    const segEnd = offset + segments[j].text.length;
    if (segEnd > ms && segStart < me && segRegions[j].deleted) return true;
    offset = segEnd;
  }
  return false;
}

/**
 * test_report_38 F2 (mimic LyX — lyxfind.cpp `replaceAll`): is a non-marker
 * property at child index `childIndex` STRICTLY inside a matched span?
 *
 * LyX erases the whole matched range, removing any font change points strictly
 * inside it, and re-inserts the replacement at the match-start font. A property
 * whose neighboring text characters are BOTH matched sits inside the erased
 * range and must be dropped — keeping it was the DL77 bug (it got reordered to
 * the front of the paragraph, wrapping nothing). Properties at the match EDGES
 * are kept (they set the match-start / post-match font).
 */
function propertyStrictlyInsideMatch(
  children: Node[],
  segments: TextSegment[],
  segStartOffsets: number[],
  isMatched: boolean[],
  childIndex: number,
): boolean {
  // Nearest text node (visible or deleted) on each side of the property —
  // ensures the property is ADJACENT to text, not separated by deleted text.
  let beforeIdx = -1;
  for (let k = childIndex - 1; k >= 0; k--) {
    if (children[k].type === "text") { beforeIdx = k; break; }
  }
  let afterIdx = -1;
  for (let k = childIndex + 1; k < children.length; k++) {
    if (children[k].type === "text") { afterIdx = k; break; }
  }
  if (beforeIdx === -1 || afterIdx === -1) return false;

  // Both neighbors must be segments (deleted text is in `segments` too —
  // mutations see all text, dev log 90).
  let segBefore = -1;
  let segAfter = -1;
  for (let j = 0; j < segments.length; j++) {
    if (segments[j].childIndex === beforeIdx) segBefore = j;
    if (segments[j].childIndex === afterIdx) segAfter = j;
  }
  if (segBefore === -1 || segAfter === -1 || segAfter !== segBefore + 1) return false;

  // The boundary between the two segments sits at concat offset segAfter.
  const boundary = segStartOffsets[segAfter];
  if (boundary <= 0 || boundary >= isMatched.length) return false;
  return isMatched[boundary - 1] && isMatched[boundary];
}

/**
 * Core cross-node substring replacement (dev log 90 range-erase model).
 * Concatenates ALL text children — including \change_deleted, since mutations
 * see all text by default — finds all occurrences of findStr, and rebuilds the
 * children array with matched portions handled by the uniform rule:
 * - the replacement is inserted as \change_inserted (current editor) at the
 *   match start (insert-first, matching LyX's replaceAll: erase the range,
 *   then insert at pos);
 * - the erased range becomes \change_deleted (current editor). Exceptions:
 *   matched text inside a same-author \change_inserted region is dropped (F3
 *   merge semantics), and change markers strictly inside a match are absorbed
 *   so the erased range serializes as one contiguous delete region (flat
 *   model — never nested).
 *
 * Matches that cross a structural boundary (inset between text nodes) are
 * silently skipped. When `scope` is set (a :change()/:property() selector
 * combination — dev log 92 §2.4), only matches fully inside the scope are
 * accepted: a :change() region scope disambiguates a phrase present in both
 * current and rejected text (dev log 90 §5.5), and a :property() scope
 * restricts to an inline style; the deleted-hit warning is suppressed under
 * any explicit scope (dev log 92 E7). An undefined scope = see all text by
 * default (dev log 90); deletedHitCount reports how many occurrences touched
 * \change_deleted text, so the caller can warn.
 */
export function applyCrossNodeReplace(
  children: Node[],
  findStr: string,
  newValue: string,
  tracked: boolean,
  authorId: number,
  ts: string,
  scope?: ScopePredicate,
  inheritedState?: TraversalState,
): { newChildren: Node[]; matchCount: number; deletedHitCount: number; crossedInsetCount: number } {
  const { segments, fullText } = concatenateTextNodes(children, {
    includeDeleted: true,
    inheritedState,
  });
  if (segments.length === 0 || fullText.length === 0) {
    return { newChildren: [...children], matchCount: 0, deletedHitCount: 0, crossedInsetCount: 0 };
  }

  // Find all match positions in the concatenated text
  const matchStarts: number[] = [];
  let pos = 0;
  while ((pos = fullText.indexOf(findStr, pos)) !== -1) {
    matchStarts.push(pos);
    pos += findStr.length;
  }
  if (matchStarts.length === 0) return { newChildren: [...children], matchCount: 0, deletedHitCount: 0, crossedInsetCount: 0 };

  // Precompute each segment's original region + inline-style state, so matched
  // runs can be treated per-region (same-author inserted → drop; deleted →
  // absorb), scope matches per-segment (dev log 92), and matches touching
  // rejected text can be counted for the warning.
  const segRegions: {
    deleted: boolean;
    inserted: boolean;
    author: number;
    props: Record<string, string | undefined>;
  }[] = [];
  {
    const state = enterTraversalState(inheritedState ?? createTraversalState());
    let seg = 0;
    for (let i = 0; i < children.length; i++) {
      const c = children[i];
      if (c.type === "property" && (isChangeOpener(c.key) || isChangeCloser(c.key))) {
        advanceTraversalState(state, c.key, c.value);
      } else if (c.type === "property" && isInlineStyleKey(c.key)) {
        advanceTraversalState(state, c.key, c.value);
      } else if (c.type === "text" && seg < segments.length && segments[seg].childIndex === i) {
        const change = traversalChange(state);
        segRegions.push({
          deleted: traversalRegion(state) === "deleted",
          inserted: traversalRegion(state) === "inserted",
          author: change.author,
          props: { ...state.properties },
        });
        seg++;
      }
    }
  }

  // Build a boolean array: isMatched[i] = true if character i is inside a valid match
  const isMatched = new Array(fullText.length).fill(false);
  let validCount = 0;
  let deletedHitCount = 0;
  let crossedInsetCount = 0;
  for (const ms of matchStarts) {
    const me = ms + findStr.length;
    const s = mapPosToSegment(segments, ms);
    // Use me-1 (last matched character) so a match ending at a segment
    // boundary doesn't map to the next segment and falsely check for
    // blocks beyond the actual match range.
    const e = mapPosToSegment(segments, me > 0 ? me - 1 : 0);
    if (segmentsCrossInset(children, segments[s.segIdx], segments[e.segIdx])) {
      // The phrase is present in the concatenated text but every occurrence
      // spans an inset — the caller reports this explicitly (dev log 91 F2).
      crossedInsetCount++;
      continue;
    }
    // Scope from the selector's state predicates (dev log 92 §2.4): only
    // matches fully inside the scope are accepted; an undefined scope sees
    // all text by default (dev log 90 §5.5).
    if (scope && !matchInScope(segments, segRegions, ms, me, scope)) continue;
    if (!scope && rangeTouchesDeleted(segments, segRegions, ms, me)) deletedHitCount++;
    for (let p = ms; p < me; p++) isMatched[p] = true;
    validCount++;
  }
  if (validCount === 0) return { newChildren: [...children], matchCount: 0, deletedHitCount, crossedInsetCount };

  // Concat offset of each segment's start — used to decide whether a property
  // between two segments sits strictly inside a matched span (test_report_38 F2).
  const segStartOffsets: number[] = [];
  {
    let acc = 0;
    for (const s of segments) {
      segStartOffsets.push(acc);
      acc += s.text.length;
    }
  }

  // --- Rebuild (range-erase) ---
  // Build a list of output atoms, then serialize with change markers derived
  // from per-position state transitions (flat model: markers fire on state
  // change; a different-type opener terminates the open region without a
  // closer).
  type OutState = "u" | "d" | "i";
  interface Atom {
    kind: "text" | "prop" | "block";
    text?: string;
    state?: OutState;
    author?: number;
    ts?: string;
    node?: Node;
  }
  const atoms: Atom[] = [];
  let concatPos = 0; // cursor in the concatenated fullText
  let segIdx = 0;    // current segment index
  let inMatch = false;
  // Non-marker properties encountered after a match's last character are
  // deferred and emitted right after the match, so the replacement inherits
  // the match-start font (test_report_38 F2, e.g. \emph default closing a
  // match that started inside an emphasized region).
  let pendingProps: Node[] = [];
  // Original region state derived from the change markers while walking.
  const openTraversalState = enterTraversalState(inheritedState ?? createTraversalState());
  const openState = (): OutState => {
    const region = traversalRegion(openTraversalState);
    return region === "deleted" ? "d" : region === "inserted" ? "i" : "u";
  };

  const flushProps = () => {
    for (const p of pendingProps) atoms.push({ kind: "prop", node: p });
    pendingProps = [];
  };

  for (let i = 0; i < children.length; i++) {
    const child = children[i];

    // Is this child a text segment in the concatenation?
    if (segIdx < segments.length && segments[segIdx].childIndex === i) {
      const seg = segments[segIdx];
      const segStart = concatPos;
      const segText = seg.text;
      const segRegion = segRegions[segIdx];

      // DL81 (test_report_34 Finding 2): for UNTRACKED matches entirely within
      // a single text node, replace in place so the node — and thus its
      // serialized line — stays intact. Splitting e.g. `name "sec:Section_label"`
      // into three nodes serializes to three lines, which LyX rejects. A matched
      // run of exactly findStr.length within one segment is a complete match
      // (a cross-node match's per-segment part is always shorter).
      if (!tracked && segText.length > 0) {
        let inPlaceText: string | null = null;
        let needsStandardPath = false;
        let k = 0;
        while (k < segText.length) {
          const gp = segStart + k;
          if (isMatched[gp]) {
            let re = k;
            while (re < segText.length && isMatched[segStart + re]) re++;
            if ((re - k) !== findStr.length) {
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
        if (!needsStandardPath && inPlaceText !== null) {
          const change = traversalChange(openTraversalState);
          atoms.push({ kind: "text", text: inPlaceText, state: openState(), author: change.author, ts: change.ts });
          concatPos += segText.length;
          segIdx++;
          continue;
        }
      }

      if (segText.length === 0) {
        // Empty text node (a blank line) — preserve it (test_report_36 F3).
        if (inMatch) {
          inMatch = false;
          flushProps();
        }
        atoms.push({ kind: "text", text: "", state: "u" });
        concatPos += segText.length;
        segIdx++;
        continue;
      }

      // Standard (split) path with range-erase handling.
      let charIdx = 0;
      while (charIdx < segText.length) {
        const globalPos = segStart + charIdx;

        if (isMatched[globalPos]) {
          // Find end of this matched run within the segment
          let runEnd = charIdx;
          while (runEnd < segText.length && isMatched[segStart + runEnd]) runEnd++;
          const runText = segText.substring(charIdx, runEnd);
          if (!inMatch) {
            // New match — the replacement lands at the match start
            // (insert-first, LyX replaceAll: insert(pos, ...) after
            // eraseChars(pos, pos + match_len)).
            inMatch = true;
            if (tracked) atoms.push({ kind: "text", text: newValue, state: "i", author: authorId, ts });
            else atoms.push({ kind: "text", text: newValue, state: "u" });
          }
          if (tracked) {
            // Erased run: same-author inserted text is dropped (F3 merge —
            // same-author deletion of pending-inserted text removes it);
            // everything else becomes DELETED by the current editor (LyX
            // eraseChars re-authors the whole erased range).
            if (!(segRegion.inserted && segRegion.author === authorId)) {
              atoms.push({ kind: "text", text: runText, state: "d", author: authorId, ts });
            }
          }
          // untracked: erased text is dropped (no atoms)
          charIdx = runEnd;
        } else {
          if (inMatch) {
            inMatch = false;
            flushProps();
          }
          // Find end of this unmatched run
          let runEnd = charIdx;
          while (runEnd < segText.length && !isMatched[segStart + runEnd]) runEnd++;
          atoms.push({
            kind: "text",
            text: segText.substring(charIdx, runEnd),
            state: openState(),
            author: traversalChange(openTraversalState).author,
            ts: traversalChange(openTraversalState).ts,
          });
          charIdx = runEnd;
        }
      }

      concatPos += segText.length;
      segIdx++;
    } else {
      // Non-segment child (change marker, font property, or block).

      if (child.type === "property" && (isChangeOpener(child.key) || isChangeCloser(child.key))) {
        // Change markers are derived during serialization — only update the
        // walk's region state here. Markers strictly inside a match are
        // absorbed (the erased range re-serializes as one delete region).
        advanceTraversalState(openTraversalState, child.key, child.value);
        continue;
      }

      if (inMatch && child.type === "block") {
        // Flush before a block boundary (a match never legitimately crosses
        // an inset — segmentsCrossInset skips those — so this is a safety net).
        inMatch = false;
        flushProps();
      }

      // test_report_38 F2: a non-marker property strictly inside a matched
      // span is dropped (LyX erases the span including its font change points
      // and re-inserts at the match-start font). Properties at the match EDGES
      // are kept: one before the match applies to the replacement (match-start
      // font), one after the match is deferred so it lands after the match.
      if (child.type === "property") {
        if (propertyStrictlyInsideMatch(children, segments, segStartOffsets, isMatched, i)) {
          continue; // drop — strictly inside the matched span
        }
        if (inMatch) {
          pendingProps.push(child); // defer — emit after the match
          continue;
        }
      }

      atoms.push({ kind: child.type === "block" ? "block" : "prop", node: child } as Atom);
    }
  }

  // Flush any trailing matched text
  if (inMatch) {
    inMatch = false;
    flushProps();
  }

  // --- Serialize atoms into children with marker emission on state change ---
  const result: Node[] = [];
  let curState: OutState = "u";
  let curAuthor = -1;
  const emitText = (text: string, state: OutState, author: number, tsv: string) => {
    if (state === "u") {
      if (curState !== "u") {
        result.push({ type: "property", key: "change_unchanged" });
        curState = "u";
      }
    } else {
      if (!(curState === state && curAuthor === author)) {
        const key = state === "d" ? "change_deleted" : "change_inserted";
        result.push({ type: "property", key, value: `${author} ${tsv}` });
        curState = state;
        curAuthor = author;
      }
    }
    result.push({ type: "text", text });
  };
  for (const atom of atoms) {
    if (atom.kind === "text") {
      if (atom.text === "") {
        // Empty text nodes carry no state — emit verbatim without transitions.
        result.push({ type: "text", text: "" });
        continue;
      }
      emitText(atom.text!, atom.state!, atom.author!, atom.ts!);
    } else {
      result.push(atom.node!);
    }
  }
  if (curState !== "u") result.push({ type: "property", key: "change_unchanged" });

  return { newChildren: result, matchCount: validCount, deletedHitCount, crossedInsetCount };
}
