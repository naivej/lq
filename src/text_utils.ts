import type { Node, BlockNode } from "./ast.ts";

export type TextRegion = "deleted" | "inserted" | "current";

/**
 * The private-note type of an invisible-in-output note inset block — `Note`
 * (Note Note) or `Comment` (Note Comment) — or undefined for anything else
 * (Greyedout is visible output and is NOT included).
 */
export function invisibleInsetType(block: BlockNode): string | undefined {
  if (block.type !== "block" || block.tag !== "inset") return undefined;
  const args = (block.args ?? "").trim();
  if (args === "Note Note") return "Note";
  if (args === "Note Comment") return "Comment";
  return undefined;
}

/**
 * Is this block a private (invisible-in-output) note inset — `Note Note` or
 * `Note Comment`? `Note Greyedout` is visible output and is NOT included.
 * Shared by the query engine and split-after so the private set lives in one
 * place (dev log 99 — F2 notes visibility).
 */
export function isInvisibleInset(block: BlockNode): boolean {
  return invisibleInsetType(block) !== undefined;
}

export interface TraversalState {
  deletedDepth: number;
  insertedDepth: number;
  deletedAuthor: number;
  deletedTs: string;
  insertedAuthor: number;
  insertedTs: string;
  outerDeletedDepth: number;
  outerInsertedDepth: number;
  outerDeletedAuthor: number;
  outerDeletedTs: string;
  outerInsertedAuthor: number;
  outerInsertedTs: string;
  properties: Record<string, string | undefined>;
}

export function createTraversalState(): TraversalState {
  return {
    deletedDepth: 0,
    insertedDepth: 0,
    deletedAuthor: 0,
    deletedTs: "",
    insertedAuthor: 0,
    insertedTs: "",
    outerDeletedDepth: 0,
    outerInsertedDepth: 0,
    outerDeletedAuthor: 0,
    outerDeletedTs: "",
    outerInsertedAuthor: 0,
    outerInsertedTs: "",
    properties: {},
  };
}

export function cloneTraversalState(state: TraversalState): TraversalState {
  return {
    ...state,
    properties: { ...state.properties },
  };
}

export function traversalRegion(state: TraversalState): TextRegion {
  if (state.deletedDepth > 0) return "deleted";
  if (state.insertedDepth > 0) return "inserted";
  if (state.outerDeletedDepth > 0) return "deleted";
  if (state.outerInsertedDepth > 0) return "inserted";
  return "current";
}

export function traversalChange(state: TraversalState): { author: number; ts: string } {
  if (state.deletedDepth > 0) return { author: state.deletedAuthor, ts: state.deletedTs };
  if (state.insertedDepth > 0) return { author: state.insertedAuthor, ts: state.insertedTs };
  if (state.outerDeletedDepth > 0) return { author: state.outerDeletedAuthor, ts: state.outerDeletedTs };
  if (state.outerInsertedDepth > 0) return { author: state.outerInsertedAuthor, ts: state.outerInsertedTs };
  return { author: 0, ts: "" };
}

/** Enter a nested structural child list without losing its enclosing state. */
export function enterTraversalState(parent: TraversalState): TraversalState {
  const child = createTraversalState();
  const region = traversalRegion(parent);
  const change = traversalChange(parent);
  if (region === "deleted") {
    child.outerDeletedDepth = 1;
    child.outerDeletedAuthor = change.author;
    child.outerDeletedTs = change.ts;
  } else if (region === "inserted") {
    child.outerInsertedDepth = 1;
    child.outerInsertedAuthor = change.author;
    child.outerInsertedTs = change.ts;
  }
  child.properties = { ...parent.properties };
  return child;
}

/** Apply one LyX property marker to an inherited recursive traversal state. */
export function advanceTraversalState(
  state: TraversalState,
  key: string,
  value?: string,
): void {
  if (key === "change_deleted" || key === "change_inserted" || key === "change_unchanged") {
    const previousDeletedDepth = state.deletedDepth;
    const previousInsertedDepth = state.insertedDepth;
    const depths = advanceChangeDepths(key, previousDeletedDepth, previousInsertedDepth);
    state.deletedDepth = depths.deletedDepth;
    state.insertedDepth = depths.insertedDepth;

    if (key === "change_deleted") {
      const parts = value?.trim().split(/\s+/) ?? [];
      state.deletedAuthor = parseInt(parts[0] ?? "", 10) || 0;
      state.deletedTs = parts[1] ?? "0";
      state.insertedAuthor = 0;
      state.insertedTs = "";
    } else if (key === "change_inserted") {
      const parts = value?.trim().split(/\s+/) ?? [];
      state.insertedAuthor = parseInt(parts[0] ?? "", 10) || 0;
      state.insertedTs = parts[1] ?? "0";
      state.deletedAuthor = 0;
      state.deletedTs = "";
    } else {
      if (previousDeletedDepth > 0 && state.deletedDepth === 0) {
        state.deletedAuthor = 0;
        state.deletedTs = "";
      }
      if (previousInsertedDepth > 0 && state.insertedDepth === 0) {
        state.insertedAuthor = 0;
        state.insertedTs = "";
      }
    }
    return;
  }

  state.properties[key] = value;
}

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
  /** Effective change/style state at this text node, including enclosing insets. */
  state: TraversalState;
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
 * Build a concatenated view of text children. Callers can exclude text inside
 * \change_deleted blocks with the default `includeDeleted: false`; selector
 * and mutation callers opt into the see-all view. Change tracking markers (change_deleted,
 * change_inserted, change_unchanged) are transparent — they don't
 * break concatenation. Only structural children (insets, nested
 * layouts) act as implicit boundaries (detected via childIndex gaps).
 *
 * With `opts.recurseLayouts`, text is also collected from nested `layout`
 * blocks (descending through `inset` blocks like `Foot` to reach them), so
 * `split-after` can target text inside a footnote (test_report_38 F3). Text is
 * collected only under a layout container — inset metadata (a Foot `status`
 * line, a CommandInset `name "…"` line) is not matchable. Enclosing change
 * and style state is inherited through those structural blocks. Each segment
 * carries its owning children list (`owner`) and effective state.
 */
export function concatenateTextNodes(
  children: Node[],
  opts?: {
    recurseLayouts?: boolean;
    topLevelIsLayout?: boolean;
    includeDeleted?: boolean;
    inheritedState?: TraversalState;
    /** DL99: when true (and recurseLayouts), do not descend into private note
     *  insets (Note Note / Note Comment) — split-after must not leak into them
     *  unless the target is note-scoped. Inert when recurseLayouts is false, so
     *  the --find / :contains non-recursive paths are unaffected. */
    skipInvisibleNotes?: boolean;
  },
): { segments: TextSegment[]; fullText: string } {
  const segments: TextSegment[] = [];
  const recurse = opts?.recurseLayouts ?? false;
  const topLevelIsLayout = opts?.topLevelIsLayout ?? true;
  const includeDeleted = opts?.includeDeleted ?? false;
  const skipInvisibleNotes = opts?.skipInvisibleNotes ?? false;

  function walk(list: Node[], collectText: boolean, inheritedState: TraversalState): void {
    const state = enterTraversalState(inheritedState);
    for (let i = 0; i < list.length; i++) {
      const child = list[i];
      if (child.type === "property") {
        advanceTraversalState(state, child.key, child.value);
      } else if (child.type === "text") {
        // Selectors and mutation callers pass includeDeleted=true so a phrase
        // inside \\change_deleted remains reachable; callers that need a
        // current-only view can leave the option false.
        if (collectText && (includeDeleted || traversalRegion(state) !== "deleted")) {
          const segmentState = cloneTraversalState(state);
          if (recurse) {
            segments.push({ childIndex: i, text: child.text, owner: list, state: segmentState });
          } else {
            segments.push({ childIndex: i, text: child.text, state: segmentState });
          }
        }
      } else if (child.type === "block" && recurse) {
        const b = child as BlockNode;
        if (b.tag === "layout") {
          walk(b.children, true, state); // collect text under nested layouts
        } else if (b.tag === "inset") {
          // DL99: private notes are invisible content — do not descend into
          // them when skipInvisibleNotes is set (split-after leak fix).
          if (skipInvisibleNotes && isInvisibleInset(b)) continue;
          // Descend through insets to reach their nested layouts, but do NOT
          // collect inset metadata text (e.g. a CommandInset label line).
          walk(b.children, false, state);
        }
      }
    }
  }
  walk(children, topLevelIsLayout, opts?.inheritedState ?? createTraversalState());

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
