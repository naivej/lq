import { DocumentNode, Node, BlockNode } from "./ast.ts";
import {
  advanceChangeDepths,
  advanceTraversalState,
  cloneTraversalState,
  concatenateTextNodes,
  createTraversalState,
  enterTraversalState,
  invisibleInsetType,
  isInvisibleInset,
  traversalRegion,
  type TraversalState,
} from "./text_utils.ts";
import { INLINE_PROPERTIES, isInlineStyleKey } from "./registry.ts";

export interface PseudoClass {
  name: "first" | "last" | "contains" | "nth-match" | "not" | "adjacent" | "until" | "change" | "property" | "note";
  argRaw?: string;
}

export interface SelectorPart {
  tag?: string;      // e.g., 'layout', 'inset'
  argExact?: string; // e.g., 'Section' inside [Section]
  pseudos?: PseudoClass[];
  combinator?: "descendant" | "sibling"; // space (default) or ~
}

export type Selector = SelectorPart[][]; // Array of paths, where each path is an array of parts

/** Parse pseudo-classes from a suffix string (e.g. ":first:contains('foo')"). */
function parsePseudoClasses(suffix: string): PseudoClass[] {
  const pseudos: PseudoClass[] = [];
  if (!suffix) return pseudos;

  const pseudoRegex = /:([a-zA-Z0-9_-]+)(?:\(((?:[^()"']|"[^"]*"|'[^']*'|\((?:[^()"']|"[^"]*"|'[^']*')*\))*)\))?/g;
  let pMatch;
  let matchedLength = 0;
  while ((pMatch = pseudoRegex.exec(suffix)) !== null) {
    const pName = pMatch[1];
    const pArg = pMatch[2] ? pMatch[2].trim() : undefined;

    if (!["first", "last", "nth-match", "contains", "not", "adjacent", "until", "change", "property", "note"].includes(pName)) {
      throw new Error(`Unsupported pseudo-class: :${pName}`);
    }

    if (pName === "change" && !pArg) {
      throw new Error(`:change() requires an argument, e.g. :change(current|inserted|deleted)`);
    }

    if (pName === "property" && !pArg) {
      throw new Error(`:property() requires an argument, e.g. :property(emph) or :property(family=roman)`);
    }

    if (pName === "note" && pArg !== undefined) {
      // DL99: bare :note = any private type; :note(Note) / :note(Comment) = one.
      let noteType = pArg;
      if (noteType.startsWith('"') && noteType.endsWith('"')) noteType = noteType.substring(1, noteType.length - 1);
      if (noteType.startsWith("'") && noteType.endsWith("'")) noteType = noteType.substring(1, noteType.length - 1);
      if (noteType !== "Note" && noteType !== "Comment") {
        throw new Error(
          `Invalid :note() argument: '${noteType}'. Valid private note types: Note, Comment. ` +
          `Greyedout is visible output and is not excluded.`
        );
      }
    }

    if (pName === "not" || pName === "adjacent" || pName === "until") {
      if (!pArg) throw new Error(`:${pName}() requires a selector argument, e.g. :${pName}(layout[Section])`);
      // Allow bare pseudo-classes in inner selectors — :not(:contains('TODO'))
      // is valid even though :contains('TODO') has no tag at the top level.
      try { parseSelectorPart(pArg, true); } catch {
        throw new Error(`Invalid selector inside :${pName}(): ${pArg}`);
      }
    }

    pseudos.push({ name: pName as PseudoClass["name"], argRaw: pArg });
    matchedLength += pMatch[0].length;
  }

  if (matchedLength !== suffix.length) {
    throw new Error(`Invalid pseudo-class syntax: ${suffix}`);
  }

  return pseudos;
}

/** Parse a single selector part string (e.g. "inset[CommandInset bibtex]") into a SelectorPart.
 *  Set allowBarePseudo to true when validating inner selectors inside :not()/:adjacent(),
 *  where bare pseudo-classes like :contains('text') are valid match criteria. */
function parseSelectorPart(raw: string, allowBarePseudo = false): SelectorPart {
  const tagMatch = raw.match(/^([a-zA-Z0-9_-]+)?(?:\[(.*?)\])?/);
  if (!tagMatch) throw new Error(`Invalid selector: ${raw}`);

  const tag = tagMatch[1];
  const rawArg = tagMatch[2];

  // Text nodes carry no [args] — args select block/property identity. Allowing
  // text[arg] would silently ignore the filter and match every text node (dev
  // log 91 F1-b); hard-error instead, pointing at the two valid selectors.
  if (tag === "text" && rawArg) {
    throw new Error(
      `Invalid selector: text nodes have no [args] ('${rawArg}' selects layout/inset/property identity). ` +
      `Select text by content (text:contains('...')) or by tracked-change region (text:change(current|inserted|deleted)).`
    );
  }

  let argExact: string | undefined = undefined;
  if (rawArg) {
    const attrMatch = rawArg.match(/^(?:[a-zA-Z0-9_-]+=['"]?([^'"]+)['"]?|['"]?([^'"]+)['"]?)$/);
    if (attrMatch) {
      argExact = attrMatch[1] !== undefined ? attrMatch[1] : attrMatch[2];
    } else {
      argExact = rawArg;
    }
  }

  // Parse pseudo-classes from the remainder (after tag + optional [args])
  const pseudoString = raw.substring(tagMatch[0].length);
  const pseudos = parsePseudoClasses(pseudoString);

  // Pseudo-classes must follow a tag at the top level — bare :contains(),
  // :first, etc. match garbage (body, text nodes).  Skip this check when
  // validating inner selectors for :not()/:adjacent().
  if (pseudos.length > 0 && !tag && !allowBarePseudo) {
    throw new Error(
      "Pseudo-classes must follow a tag. Use layout, inset, or property before pseudo-classes."
    );
  }

  return { tag, argExact, pseudos: pseudos.length > 0 ? pseudos : undefined };
}

/** Split a string by a separator character, respecting brackets, quotes, and paren depth.
 *  Used for both whitespace-splitting selector parts and comma-splitting selector groups. */
function splitRespectingDelimiters(str: string, sep: string): string[] {
  const parts: string[] = [];
  let current = "";
  let parenDepth = 0;
  let inBracket = false;
  let inDoubleQuote = false;
  let inSingleQuote = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (inDoubleQuote) {
      current += ch;
      if (ch === '"') inDoubleQuote = false;
    } else if (inSingleQuote) {
      current += ch;
      if (ch === "'") inSingleQuote = false;
    } else if (ch === '"') {
      current += ch;
      inDoubleQuote = true;
    } else if (ch === "'") {
      current += ch;
      inSingleQuote = true;
    } else if (ch === '[') {
      current += ch;
      inBracket = true;
    } else if (ch === ']') {
      current += ch;
      inBracket = false;
    } else if (ch === '(') {
      current += ch;
      parenDepth++;
    } else if (ch === ')') {
      current += ch;
      parenDepth--;
    } else if (ch === sep) {
      if (parenDepth === 0 && !inBracket) {
        if (current.length > 0) {
          parts.push(current);
          current = "";
        }
      } else {
        current += ch;
      }
    } else {
      current += ch;
    }
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

/** Split a selector string by whitespace, respecting brackets, quotes, and paren depth. */
function splitSelectorByWhitespace(sel: string): string[] {
  const result: string[] = [];
  // Split by space, tab, and newline — each treated as a separate separator
  for (const part of splitRespectingDelimiters(sel, " ")) {
    for (const sub of splitRespectingDelimiters(part, "\t")) {
      for (const sub2 of splitRespectingDelimiters(sub, "\n")) {
        if (sub2.length > 0) result.push(sub2);
      }
    }
  }
  return result;
}

export function parseSelector(selector: string): SelectorPart[][] {
  return splitRespectingDelimiters(selector, ",").map((sel) => {
    // Validate bracket balance
    const unquoted = sel.replace(/"[^"]*"/g, "").replace(/'[^']*'/g, "");
    if ((unquoted.match(/\[/g) || []).length !== (unquoted.match(/\]/g) || []).length) throw new Error(`Unclosed bracket in selector part: ${sel}`);
    
    // Split by ~ to get sibling-combinator groups, then split each group by whitespace.
    // The first group uses default descendant combinator; subsequent groups'
    // first part gets combinator: "sibling".
    const tildeGroups = splitRespectingDelimiters(sel.trim(), "~");
    const allParts: SelectorPart[] = [];
    
    for (let gi = 0; gi < tildeGroups.length; gi++) {
      const groupParts = splitSelectorByWhitespace(tildeGroups[gi].trim());
      for (let pi = 0; pi < groupParts.length; pi++) {
        const part = groupParts[pi];
        const parsedPart = parseSelectorPart(part);
        const sp: SelectorPart = {
          ...parsedPart,
          pseudos: parsedPart.pseudos ?? [],
        };
        // First part of each ~ group after the first gets sibling combinator
        if (gi > 0 && pi === 0) sp.combinator = "sibling";
        allParts.push(sp);
      }
    }
    
    return allParts;
  });
}

function nodeContainsText(node: Node, searchStr: string, noteScope: boolean): boolean {
  if (node.type === "text") {
    return node.text.includes(searchStr);
  } else if (node.type === "block") {
    // Use shared concatenation utility so phrases spanning
    // punctuation-induced text-node boundaries match. Selectors see ALL text,
    // including \change_deleted (a selector locates nodes; mutations --find /
    // split-after see only current text — dev log 87 D7).
    const { fullText } = concatenateTextNodes(node.children, { includeDeleted: true });
    if (fullText.includes(searchStr)) return true;
    // Also recurse into sub-blocks (insets, nested layouts). DL99: private
    // note insets are skipped unless the query is note-scoped — the visible
    // document is the default view for content matching.
    for (const child of node.children) {
      if (child.type === "block") {
        const b = child as BlockNode;
        if (!noteScope && isInvisibleInset(b)) continue;
        if (nodeContainsText(b, searchStr, noteScope)) return true;
      }
    }
  }
  return false;
}

/** Region a node sits in, computed from the change markers before it in its
 * parent's children: "deleted" | "inserted" | "current".
 */
export function regionAt(list: Node[], index: number): "deleted" | "inserted" | "current" {
  let deletedDepth = 0;
  let insertedDepth = 0;
  for (let i = 0; i < index; i++) {
    const c = list[i];
    if (c.type === "property" && isChangeMarkerKey(c.key)) {
      const d = advanceChangeDepths(c.key, deletedDepth, insertedDepth);
      deletedDepth = d.deletedDepth;
      insertedDepth = d.insertedDepth;
    }
  }
  return deletedDepth > 0 ? "deleted" : insertedDepth > 0 ? "inserted" : "current";
}

export function buildTraversalStateIndex(rootChildren: Node[]): Map<Node, TraversalState> {
  const index = new Map<Node, TraversalState>();

  function walk(list: Node[], inheritedState: TraversalState, collectText: boolean): void {
    const state = enterTraversalState(inheritedState);
    for (const node of list) {
      if (node.type !== "text" || collectText) {
        index.set(node, cloneTraversalState(state));
      }
      if (node.type === "block") {
        const childCollectText = node.tag === "layout"
          ? true
          : node.tag === "inset"
          ? false
          : collectText;
        walk(node.children, state, childCollectText);
      }
      if (node.type === "property") advanceTraversalState(state, node.key, node.value);
    }
  }

  walk(rootChildren, createTraversalState(), false);
  return index;
}

/** Change marker keys (\change_deleted / \change_inserted / \change_unchanged). */
function isChangeMarkerKey(key: string): boolean {
  return key === "change_deleted" || key === "change_inserted" || key === "change_unchanged";
}

/** Inline-style values that mean "not active" (reset/off) — :property(key) matches only non-default values. */
const INACTIVE_PROPERTY_VALUES = new Set(["default", "off", "no", "inherit"]);

interface PropertyArg {
  key: string;
  value?: string;
}

/** Parse a :property() argument: `key` (active, any non-default value) or `key=value`. */
function parsePropertyArg(raw: string): PropertyArg {
  let arg = raw;
  if (arg.startsWith('"') && arg.endsWith('"')) arg = arg.substring(1, arg.length - 1);
  if (arg.startsWith("'") && arg.endsWith("'")) arg = arg.substring(1, arg.length - 1);
  const eq = arg.indexOf("=");
  const key = (eq >= 0 ? arg.substring(0, eq) : arg).trim();
  const value = eq >= 0 ? arg.substring(eq + 1).trim() : undefined;
  if (!key) throw new Error(`:property() requires a key, e.g. :property(emph) or :property(family=roman)`);
  if (!isInlineStyleKey(key)) {
    throw new Error(
      `Invalid :property() key: '${key}'. Valid inline style keys are: ${INLINE_PROPERTIES.filter(isInlineStyleKey).join(", ")}. ` +
      `Tracked-change regions are selected with :change(current|inserted|deleted).`
    );
  }
  return { key, value };
}

/** Does an active value satisfy a :property() predicate? (case-insensitive, mirroring LyX's ascii_lowercase) */
function matchesProperty(active: string | undefined, prop: PropertyArg): boolean {
  if (active === undefined) return false;
  const a = active.toLowerCase();
  if (prop.value !== undefined) return a === prop.value.toLowerCase();
  return !INACTIVE_PROPERTY_VALUES.has(a);
}

/** Active inline-style values at a given index, from the style markers before it in its parent's children. */
export function propertyStateAt(list: Node[], index: number): Record<string, string | undefined> {
  const state: Record<string, string | undefined> = {};
  for (let i = 0; i < index; i++) {
    const c = list[i];
    if (c.type === "property" && isInlineStyleKey(c.key)) {
      state[c.key] = c.value;
    }
  }
  return state;
}

/** Parse a :change() argument (single region — no list syntax, dev log 92 §2.4/E6). */
export function parseChangeArg(raw: string): "current" | "inserted" | "deleted" {
  let want = raw;
  if (want.startsWith('"') && want.endsWith('"')) want = want.substring(1, want.length - 1);
  if (want.startsWith("'") && want.endsWith("'")) want = want.substring(1, want.length - 1);
  if (want !== "current" && want !== "inserted" && want !== "deleted") {
    throw new Error(`Invalid :change() argument: ${want}. Expected current, inserted, or deleted.`);
  }
  return want;
}

export type ScopeState = "current" | "inserted" | "deleted";
export type ScopePredicate = (region: ScopeState, props: Record<string, string | undefined>) => boolean;

/**
 * Build the mutation scope predicate from a selector (dev log 92 §2.4/§2.5):
 * OR across `,` groups, AND across chained :change()/:property() within a
 * group; a group with no state predicates is unconstrained (E1/E4). Returns
 * undefined when the selector has no state predicates at all (see-all
 * default — mutations see all text, dev log 90).
 */
export function buildScopePredicate(selectorStr: string): ScopePredicate | undefined {
  const groups = parseSelector(selectorStr);
  const groupPreds: ScopePredicate[] = [];
  let hasState = false;
  for (const group of groups) {
    const partPreds: ScopePredicate[] = [];
    for (const part of group) {
      if (!part.pseudos) continue;
      for (const p of part.pseudos) {
        if (p.name === "change" && p.argRaw !== undefined) {
          hasState = true;
          const want = parseChangeArg(p.argRaw);
          partPreds.push((region) => region === want);
        } else if (p.name === "property" && p.argRaw !== undefined) {
          hasState = true;
          const prop = parsePropertyArg(p.argRaw);
          partPreds.push((_region, props) => matchesProperty(props?.[prop.key], prop));
        }
      }
    }
    groupPreds.push((region, props) => partPreds.every((p) => p(region, props)));
  }
  if (!hasState) return undefined;
  return (region, props) => groupPreds.some((g) => g(region, props));
}

/**
 * DL99: is any `,` group of the selector note-scoped — i.e. does it contain a
 * part with a `:note` pseudo, or an `inset` part whose arg first word is
 * `Note` (e.g. `inset[Note Note]`, `inset[Note Comment]`, `inset[Note]`)?
 * Note-scope is per group so `text, text:note` means "visible text + note
 * text". Used by the query engine (content matching) and by split-after
 * (cli.ts).
 */
export function selectorNoteScope(selectorStr: string): boolean {
  const groups = parseSelector(selectorStr);
  return groups.some((group) =>
    group.some((part) =>
      part.pseudos?.some((p) => p.name === "note") ||
      (part.tag === "inset" && part.argExact?.trim().split(" ")[0] === "Note")
    )
  );
}

/**
 * DL99: map of every node → true when it sits inside a private note inset
 * (Note Note / Note Comment). The note inset itself is false — it *is* the
 * note. One top-down tree walk; used by `:note` and the visible-only `text`
 * rule.
 */
function buildInsideNoteMap(rootChildren: Node[]): Map<Node, string | undefined> {
  const map = new Map<Node, string | undefined>();
  function walk(children: Node[], insideNoteType: string | undefined): void {
    for (const c of children) {
      map.set(c, insideNoteType);
      if (c.type === "block") {
        const b = c as BlockNode;
        walk(b.children, invisibleInsetType(b) ?? insideNoteType);
      }
    }
  }
  walk(rootChildren, undefined);
  return map;
}

/** Does a block contain any text under the given style state? (:property() on blocks.) */
function blockContainsProperty(
  node: BlockNode,
  prop: PropertyArg,
  stateIndex: Map<Node, TraversalState>,
): boolean {
  let found = false;
  const walk = (list: Node[]) => {
    if (found) return;
    for (const c of list) {
      if (found) return;
      if (c.type === "text") {
        const state = stateIndex.get(c);
        if (!state) continue;
        if (matchesProperty(state.properties[prop.key], prop)) {
          found = true;
          return;
        }
      } else if (c.type === "block") {
        walk((c as BlockNode).children);
      }
    }
  };
  walk(node.children);
  return found;
}

/** Does a block contain any text sitting in the given region? (:change() on layouts.) */
function blockContainsRegion(
  node: BlockNode,
  want: "current" | "inserted" | "deleted",
  stateIndex: Map<Node, TraversalState>,
): boolean {
  let found = false;
  const walk = (list: Node[]) => {
    if (found) return;
    for (const c of list) {
      if (found) return;
      if (c.type === "text") {
        const state = stateIndex.get(c);
        if (!state) continue;
        const region = traversalRegion(state);
        if (region === want) {
          found = true;
          return;
        }
      } else if (c.type === "block") {
        walk((c as BlockNode).children);
      }
    }
  };
  walk(node.children);
  return found;
}

function matchNode(
  node: Node,
  part: SelectorPart,
  region?: "deleted" | "inserted" | "current",
  propState?: Record<string, string | undefined>,
  stateIndex?: Map<Node, TraversalState>,
  insideNoteIndex?: Map<Node, string | undefined>,
  noteScope?: boolean,
): boolean {
  if (part.tag === "property") {
    if (node.type !== "property") return false;
    if (part.argExact && node.key !== part.argExact) return false;
  } else {
    let nodeTag = "";
    if (node.type === "block") {
      nodeTag = node.tag;
    } else if (node.type === "property") {
      // In normal matching, we expect property nodes to NOT match tag queries unless the tag is specifically "property" or the tag matches the property key exactly (which is less standard).
      // Wait, let's keep it simple: if part.tag is not 'property', block property nodes unless they exactly match. But LyX layouts and insets are blocks.
      nodeTag = node.key;
    } else if (node.type === "text") {
      nodeTag = "text";
    }

    if (part.tag && nodeTag !== part.tag) return false;
    if (part.argExact && node.type === "block") {
      if (node.args === undefined) return false;
      const nodeArgName = node.args.trim().split(" ")[0];
      if (node.args.trim() !== part.argExact && nodeArgName !== part.argExact) {
        return false;
      }
    }
  }

  // DL99: bare `text` is a CONTENT surface. A text node inside a private note
  // matches only when the group is note-scoped (noteScope) or the part opts in
  // with :note. Text parts carrying :change()/:property() are on the STATE
  // axis (DL93) and are unaffected by either rule.
  if (part.tag === "text" && node.type === "text") {
    const hasState = part.pseudos?.some((p) => p.name === "change" || p.name === "property") ?? false;
    if (!hasState) {
      const hasNote = part.pseudos?.some((p) => p.name === "note") ?? false;
      if (!hasNote) {
        const inside = insideNoteIndex?.get(node) ?? false;
        if (inside && !(noteScope ?? false)) return false;
      }
    }
  }

  if (part.pseudos) {
    for (const p of part.pseudos) {
      if (p.name === "contains" && p.argRaw !== undefined) {
        let val = p.argRaw;
        if (val.startsWith('"') && val.endsWith('"')) val = val.substring(1, val.length - 1);
        if (val.startsWith("'") && val.endsWith("'")) val = val.substring(1, val.length - 1);
        
        if (val === "") {
          throw new Error("Empty string not allowed in :contains()");
        }

        if (node.type === "text") {
          // Don't return TextNodes directly for :contains to avoid double mutations.
          return false;
        } else if (node.type === "block") {
          // DL99: a block inside a private note is invisible content — bare
          // content matching (no :note, no group note-scope) must not return
          // it, even when the phrase is in the node's OWN text (a note's inner
          // Plain Layout's direct prose). Note-scoped queries (:note or an
          // explicit inset[Note ...] group) still match.
          if (!(noteScope ?? false)) {
            const hasNote = part.pseudos?.some((pp) => pp.name === "note") ?? false;
            if (!hasNote && (insideNoteIndex?.get(node) ?? false)) return false;
          }
          if (!nodeContainsText(node, val, noteScope ?? false)) {
            return false;
          }
        } else {
          return false;
        }
      }
      
      if (p.name === "not" && p.argRaw !== undefined) {
        // :not(selector) — exclude this node if any descendant matches the inner selector.
        // Parse the inner selector as a SelectorPart.  Allow bare pseudo-classes
        // in the inner selector (e.g. :not(:contains('TODO'))).
        const innerPart = parseSelectorPart(p.argRaw, true);
        if (node.type === "block") {
          const matches = findDescendants(node.children, innerPart, [], stateIndex, insideNoteIndex, noteScope);
          if (matches.length > 0) return false;
          // DL115: a :contains inner also matches the node's OWN text (the
          // positive form's nodeContainsText covers it), so check the node
          // itself too — :contains(x) and :not(:contains(x)) partition.
          // Non-:contains inners have no self dimension (tag inners fail the
          // tag check; :note/:change/:property inherit to descendants), so
          // the self-check is gated on :contains to keep them byte-identical
          // (dev log 115 Option A vs rejected Option D).
          const hasContains = innerPart.pseudos?.some((pp) => pp.name === "contains") ?? false;
          if (hasContains &&
              matchNode(node, innerPart, region, propState, stateIndex, insideNoteIndex, noteScope)) {
            return false;
          }
        }
        // For non-block nodes, :not() always passes (there are no descendants to check).
      }

      if (p.name === "change" && p.argRaw !== undefined) {
        // :change(current|inserted|deleted) — select text by the region it sits
        // in (the ambiguity-resolution mechanism for the see-all mutation
        // default, dev log 90). On a text node, matches when the node's region
        // equals the argument. On a block (layout), matches when the block
        // CONTAINS text in that region (e.g. layout:change(deleted) selects
        // deleted-bearing layouts).
        const want = parseChangeArg(p.argRaw);
        if (node.type === "text") {
          if (region !== want) return false;
        } else if (node.type === "block") {
          // Matches when the block SITS IN the region of its parent OR contains
          // text in that region (dev log 92 §2.1) — so insets inside a rejected
          // run are no longer invisible.
          const sitsInParent = region === want;
          if (!sitsInParent && !blockContainsRegion(node, want, stateIndex ?? new Map())) return false;
        } else {
          return false;
        }
      }

      if (p.name === "property" && p.argRaw !== undefined) {
        // :property(key[=value]) — select nodes under an inline style state
        // (dev log 92 §2.2). Text nodes match by their active value; blocks
        // match when they SIT IN the parent's style span OR contain text
        // under the style; property nodes never match.
        const prop = parsePropertyArg(p.argRaw);
        if (node.type === "text") {
          if (!matchesProperty(propState?.[prop.key], prop)) return false;
        } else if (node.type === "block") {
          const sitsInParent = propState !== undefined && matchesProperty(propState[prop.key], prop);
          if (!sitsInParent && !blockContainsProperty(node, prop, stateIndex ?? new Map())) return false;
        } else {
          return false;
        }
      }

      if (p.name === "note") {
        // DL99: matches a private note inset itself, or any node inside one.
        // With an argument, :note(Note) / :note(Comment), the note type must
        // match — the argument selects a specific private type.
        const noteType = node.type === "block" && isInvisibleInset(node as BlockNode)
          ? invisibleInsetType(node as BlockNode)
          : insideNoteIndex?.get(node);
        if (!noteType) return false;
        if (p.argRaw !== undefined) {
          let want = p.argRaw;
          if (want.startsWith('"') && want.endsWith('"')) want = want.substring(1, want.length - 1);
          if (want.startsWith("'") && want.endsWith("'")) want = want.substring(1, want.length - 1);
          if (noteType !== want) return false;
        }
      }
    }
  }

  return true;
}

function findDescendants(
  nodes: Node[],
  part: SelectorPart,
  results: Node[] = [],
  stateIndex?: Map<Node, TraversalState>,
  insideNoteIndex?: Map<Node, string | undefined>,
  noteScope?: boolean,
): Node[] {
  for (const node of nodes) {
    const state = stateIndex?.get(node) ?? createTraversalState();
    if (
      node.type === "text" &&
      stateIndex &&
      !stateIndex.has(node) &&
      part.pseudos?.some(p => p.name === "change" || p.name === "property")
    ) {
      continue;
    }
    if (matchNode(node, part, traversalRegion(state), state.properties, stateIndex, insideNoteIndex, noteScope)) {
      results.push(node);
    }
    if (node.type === "block") {
      findDescendants(node.children, part, results, stateIndex, insideNoteIndex, noteScope);
    }
  }

  return results;
}

/**
 * Find the parent's children array and the index of a given node within it.
 * Returns null if the node is the document root.
 */
function getSiblingContext(node: Node, rootChildren: Node[]): { parentChildren: Node[]; index: number } | null {
  // Check root level
  for (let i = 0; i < rootChildren.length; i++) {
    if (rootChildren[i] === node) return { parentChildren: rootChildren, index: i };
    if (rootChildren[i].type === "block") {
      const result = getSiblingContextInBlock(node, (rootChildren[i] as BlockNode).children);
      if (result) return result;
    }
  }
  return null;
}

/**
 * O(1) sibling context lookup if parentIndex is available, otherwise O(n) tree walk.
 */
function getSiblingContextFast(
  node: Node,
  rootChildren: Node[],
  parentIndex?: Map<Node, { parentChildren: Node[]; index: number }>,
): { parentChildren: Node[]; index: number } | null {
  if (parentIndex) return parentIndex.get(node) ?? null;
  return getSiblingContext(node, rootChildren);
}

function getSiblingContextInBlock(node: Node, children: Node[]): { parentChildren: Node[]; index: number } | null {
  for (let i = 0; i < children.length; i++) {
    if (children[i] === node) return { parentChildren: children, index: i };
    if (children[i].type === "block") {
      const result = getSiblingContextInBlock(node, (children[i] as BlockNode).children);
      if (result) return result;
    }
  }
  return null;
}

/**
 * Build a flat map of every node → { parentChildren, index } for O(1) sibling lookups.
 * Avoids repeated O(n) tree walks in findFollowingSiblings and :adjacent() filters.
 */
function buildParentIndex(rootChildren: Node[]): Map<Node, { parentChildren: Node[]; index: number }> {
  const map = new Map<Node, { parentChildren: Node[]; index: number }>();
  function walk(children: Node[], parentChildren: Node[]) {
    for (let i = 0; i < children.length; i++) {
      const n = children[i];
      map.set(n, { parentChildren, index: i });
      if (n.type === "block") {
        walk(n.children, n.children);
      }
    }
  }
  walk(rootChildren, rootChildren);
  return map;
}

/**
 * Build a map from every node to its parent block node (null for root-level
 * nodes).  Used by :until() to walk up from a candidate to the top-level
 * sibling under the anchor's parent.
 */
function buildParentMap(rootChildren: Node[]): Map<Node, BlockNode | null> {
  const map = new Map<Node, BlockNode | null>();
  function walk(children: Node[], parent: BlockNode | null) {
    for (const n of children) {
      map.set(n, parent);
      if (n.type === "block") walk(n.children, n as BlockNode);
    }
  }
  walk(rootChildren, null);
  return map;
}

/**
 * Find all following siblings of the given anchor node that match `part`.
 * Used by the ~ (general sibling) combinator.
 * If parentIndex is provided, uses it for O(1) anchor lookup instead of O(n) tree walk.
 */
function findFollowingSiblings(
  anchor: Node,
  rootChildren: Node[],
  part: SelectorPart,
  parentIndex?: Map<Node, { parentChildren: Node[]; index: number }>,
  stateIndex?: Map<Node, TraversalState>,
  insideNoteIndex?: Map<Node, string | undefined>,
  noteScope?: boolean,
): Node[] {
  let ctx = parentIndex?.get(anchor);
  if (!ctx) {
    const result = getSiblingContext(anchor, rootChildren);
    if (!result) return [];
    ctx = result;
  }

  const results: Node[] = [];
  for (let i = ctx.index + 1; i < ctx.parentChildren.length; i++) {
    const sibling = ctx.parentChildren[i];
    const state = stateIndex?.get(sibling) ?? createTraversalState();
    if (matchNode(sibling, part, traversalRegion(state), state.properties, stateIndex, insideNoteIndex, noteScope)) {
      results.push(sibling);
    }
    // Also search descendants of sibling blocks (like space combinator does)
    if (sibling.type === "block") {
      findDescendants(sibling.children, part, results, stateIndex, insideNoteIndex, noteScope);
    }
  }
  return results;
}

/**
 * Check whether any node in `block`'s subtree, in document order strictly
 * after `block` and at-or-before `target` (inclusive), matches `innerPart`.
 * `target` must be a descendant of `block`.  Used by :until() to bound
 * descendant candidates whose top-level sibling is `block`.
 *
 * Returns a tri-state: `true` = a match was found in the span; `false` =
 * no match and `target` not reached (keep scanning); `null` = `target`
 * reached without a match (stop — nothing after `target` is in the span).
 * The `null` signal is what keeps the scan bounded by the candidate: without
 * it, a recursion that reaches a *nested* target returns `false` and the
 * caller keeps scanning siblings that come after the target in document
 * order (DL105 F1 — false rejection of candidates before a boundary).
 */
function subtreeHasMatchBeforeOrAt(
  block: BlockNode,
  target: Node,
  innerPart: SelectorPart,
  stateIndex?: Map<Node, TraversalState>,
  insideNoteIndex?: Map<Node, string | undefined>,
  noteScope?: boolean,
): boolean | null {
  for (const child of block.children) {
    if (child === target) {
      // Target is the last node in the range — check it, then signal reached.
      const state = stateIndex?.get(child) ?? createTraversalState();
      return matchNode(child, innerPart, traversalRegion(state), state.properties, stateIndex, insideNoteIndex, noteScope)
        ? true
        : null;
    }
    const state = stateIndex?.get(child) ?? createTraversalState();
    if (matchNode(child, innerPart, traversalRegion(state), state.properties, stateIndex, insideNoteIndex, noteScope)) return true;
    if (child.type === "block") {
      // A `null` (target reached) or `true` (match) result stops the scan —
      // later siblings come after the target in document order.
      const sub = subtreeHasMatchBeforeOrAt(child as BlockNode, target, innerPart, stateIndex, insideNoteIndex, noteScope);
      if (sub !== false) return sub;
    }
  }
  return false;
}

export function query(ast: DocumentNode, selectorStr: string): Node[] {
  const groups = parseSelector(selectorStr);
  const rootChildren = ast.type === "document" ? ast.children : (ast.type === "block" ? ast.children : []);
  const stateIndex = buildTraversalStateIndex(rootChildren);
  // DL99: one extra tree walk for the inside-note map (content visibility).
  const insideNoteIndex = buildInsideNoteMap(rootChildren);
  
  // Pre-build parent index for O(1) sibling lookups when any sibling-related
  // feature is used (~ combinator, :adjacent(), :until()).
  let parentIndex: Map<Node, { parentChildren: Node[]; index: number }> | undefined;
  const needsIndex = groups.some(g => g.some(p =>
    p.combinator === "sibling" ||
    p.pseudos?.some(ps => ps.name === "adjacent" || ps.name === "until")
  ));
  if (needsIndex) {
    parentIndex = buildParentIndex(rootChildren);
  }

  // Parent-block map, only needed by :until() to find the top-level sibling
  // under the anchor's parent for descendant candidates.
  let parentMap: Map<Node, BlockNode | null> | undefined;
  if (groups.some(g => g.some(p => p.pseudos?.some(ps => ps.name === "until")))) {
    parentMap = buildParentMap(rootChildren);
  }
  
  const finalResults = new Set<Node>();

  for (const group of groups) {
    let currentNodes: Node[] = rootChildren;
    // Track the anchor nodes for :until() bounding — each anchor corresponds
    // to a node matched in the previous stage (before the ~ combinator).
    let siblingAnchors: Node[] = [];
    // DL99: per-group note scope — a group opts into note content when it has
    // a :note pseudo or an explicit inset[Note ...] part (dev log 99 §3).
    const noteScope = group.some((part) =>
      part.pseudos?.some((p) => p.name === "note") ||
      (part.tag === "inset" && part.argExact?.trim().split(" ")[0] === "Note")
    );

    for (let i = 0; i < group.length; i++) {
      const part = group[i];
      let nextNodes: Node[] = [];

      if (part.combinator === "sibling") {
        // ~ combinator: search following siblings of each current anchor
        for (const cn of currentNodes) {
          nextNodes = nextNodes.concat(findFollowingSiblings(cn, rootChildren, part, parentIndex, stateIndex, insideNoteIndex, noteScope));
        }
        // Save current nodes as anchors for potential :until() filtering
        siblingAnchors = currentNodes;
      } else if (i === 0) {
        nextNodes = findDescendants(currentNodes, part, [], stateIndex, insideNoteIndex, noteScope);
      } else {
        for (const cn of currentNodes) {
          if (cn.type === "block") {
            nextNodes = nextNodes.concat(findDescendants(cn.children, part, [], stateIndex, insideNoteIndex, noteScope));
          }
        }
      }

      // Apply pseudo-classes (first, last, nth, nth-match, adjacent, contains, not, until)
      if (part.pseudos) {
        for (const p of part.pseudos) {
          if (p.name === "first" && nextNodes.length > 0) {
            nextNodes = [nextNodes[0]];
          } else if (p.name === "last" && nextNodes.length > 0) {
            nextNodes = [nextNodes[nextNodes.length - 1]];
          } else if (p.name === "nth-match" && p.argRaw !== undefined) {
            let formula = p.argRaw;
            if (formula === "odd") formula = "2n+1";
            if (formula === "even") formula = "2n";
            
            let a = 0, b = 0;
            const num = parseInt(formula, 10);
            if (!isNaN(num) && !formula.includes('n')) {
              a = 0; b = num;
            } else {
              const match = formula.replace(/\s+/g, "").match(/^(?:([-+]?\d*)n)?([-+]\d+)?$/);
              if (match) {
                const aRaw = match[1];
                if (aRaw === "-" || aRaw === "+") a = parseInt(aRaw + "1", 10);
                else if (aRaw) a = parseInt(aRaw, 10);
                else a = 1;
                
                if (match[2]) b = parseInt(match[2], 10);
              }
            }
            
            nextNodes = nextNodes.filter((_, idx) => {
              const n = idx + 1;
              if (a === 0) return n === b;
              return (n - b) % a === 0 && (n - b) / a >= 0;
            });
          } else if (p.name === "adjacent" && p.argRaw !== undefined) {
            const innerPart = parseSelectorPart(p.argRaw, true);
            nextNodes = nextNodes.filter(n => {
              const ctx = getSiblingContextFast(n, rootChildren, parentIndex);
              if (!ctx || ctx.index === 0) return false;
              for (let si = ctx.index - 1; si >= 0; si--) {
                const prev = ctx.parentChildren[si];
                if (prev.type === "text" || prev.type === "property") continue;
                const state = stateIndex.get(prev) ?? createTraversalState();
                return matchNode(prev, innerPart, traversalRegion(state), state.properties, stateIndex, insideNoteIndex, noteScope);
              }
              return false;
            });
          } else if (p.name === "until" && p.argRaw !== undefined) {
            // :until(selector) — rejects any candidate that has a node
            // matching the inner selector in document order strictly after
            // the ~ anchor and at-or-before the candidate itself.  This
            // bounds not only direct following siblings but also descendants
            // of following siblings, and excludes the boundary node itself.
            const innerPart = parseSelectorPart(p.argRaw, true);
            if (siblingAnchors.length > 0 && parentMap) {
              // Group anchors by their parent's children (array identity) and
              // precompute, per anchor, the FIRST sibling strictly after it
              // that is a boundary (matches the inner selector itself or
              // contains a matching descendant).  A candidate is then bounded
              // with an O(1) comparison instead of a per-candidate
              // sibling+descendant scan (DL105 F3 — `:until` was ~30x slower
              // than the equivalent query on large documents).
              const anchorGroups = new Map<Node[], { anchor: Node; index: number; firstBoundary: number }[]>();
              for (const anchor of siblingAnchors) {
                const aCtx = getSiblingContextFast(anchor, rootChildren, parentIndex);
                if (!aCtx) continue;
                let list = anchorGroups.get(aCtx.parentChildren);
                if (!list) {
                  list = [];
                  anchorGroups.set(aCtx.parentChildren, list);
                }
                list.push({ anchor, index: aCtx.index, firstBoundary: Infinity });
              }
              for (const list of anchorGroups.values()) list.sort((a, b) => a.index - b.index);
              for (const [pc, list] of anchorGroups) {
                // isB[i]: sibling i is itself a boundary or contains one.
                const isB: boolean[] = new Array(pc.length).fill(false);
                for (let i = 0; i < pc.length; i++) {
                  const sib = pc[i];
                  const st = stateIndex?.get(sib) ?? createTraversalState();
                  if (matchNode(sib, innerPart, traversalRegion(st), st.properties, stateIndex, insideNoteIndex, noteScope)) { isB[i] = true; continue; }
                  if (sib.type === "block" && findDescendants((sib as BlockNode).children, innerPart, [], stateIndex, insideNoteIndex, noteScope).length > 0) isB[i] = true;
                }
                // Backward pass: firstBoundary[anchor] = first boundary strictly after it.
                const anchorAt = new Map<number, { anchor: Node; index: number; firstBoundary: number }>();
                for (const e of list) anchorAt.set(e.index, e);
                let nextB = Infinity;
                for (let i = pc.length - 1; i >= 0; i--) {
                  const entry = anchorAt.get(i);
                  if (entry) entry.firstBoundary = nextB;
                  if (isB[i]) nextB = i;
                }
              }
              nextNodes = nextNodes.filter(n => {
                // Walk up from n to the first ancestor-or-self whose parent's
                // children contain an anchor preceding it — that node is the
                // top-level sibling under that anchor's parent.  The deepest
                // such level wins, matching the previous reverse-anchor scan.
                let cur: Node = n;
                while (true) {
                  const parent = parentMap.get(cur) ?? null;
                  if (parent === null) break; // reached the root without an anchor
                  const list = anchorGroups.get(parent.children);
                  if (list) {
                    const curCtx = getSiblingContextFast(cur, rootChildren, parentIndex);
                    if (curCtx) {
                      // Nearest anchor strictly before cur (binary search).
                      let lo = 0, hi = list.length - 1, best = -1;
                      while (lo <= hi) {
                        const mid = (lo + hi) >> 1;
                        if (list[mid].index < curCtx.index) { best = mid; lo = mid + 1; }
                        else hi = mid - 1;
                      }
                      if (best !== -1) {
                        // A boundary sibling strictly before cur? O(1).
                        if (list[best].firstBoundary < curCtx.index) return false;
                        // cur (the top-level sibling) itself,
                        const cState = stateIndex?.get(cur) ?? createTraversalState();
                        if (matchNode(cur, innerPart, traversalRegion(cState), cState.properties, stateIndex, insideNoteIndex, noteScope)) return false;
                        // and cur's subtree up to and including n.  Reject only
                        // on an actual match (true); target-reached (null) keeps n.
                        if (cur !== n) {
                          if (subtreeHasMatchBeforeOrAt(cur as BlockNode, n, innerPart, stateIndex, insideNoteIndex, noteScope) === true) return false;
                        }
                        return true;
                      }
                    }
                  }
                  cur = parent;
                }
                return true; // no anchor found, keep node
              });
            }
            // If no sibling anchors (e.g. :until() used without ~), the filter
            // has no effect — all nodes pass through.
          }
        }
      }

      currentNodes = nextNodes;
      if (currentNodes.length === 0) break;
    }

    for (const node of currentNodes) {
      finalResults.add(node);
    }
  }

  return Array.from(finalResults);
}
