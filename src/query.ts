import { DocumentNode, Node, BlockNode } from "./ast.ts";
import { advanceChangeDepths, concatenateTextNodes } from "./text_utils.ts";
import { INLINE_PROPERTIES, isInlineStyleKey } from "./registry.ts";

export interface PseudoClass {
  name: "first" | "last" | "contains" | "nth-child" | "not" | "adjacent" | "until" | "change" | "property";
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

    if (!["first", "last", "nth-child", "contains", "not", "adjacent", "until", "change", "property"].includes(pName)) {
      throw new Error(`Unsupported pseudo-class: :${pName}`);
    }

    if (pName === "change" && !pArg) {
      throw new Error(`:change() requires an argument, e.g. :change(current|inserted|deleted)`);
    }

    if (pName === "property" && !pArg) {
      throw new Error(`:property() requires an argument, e.g. :property(emph) or :property(family=roman)`);
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
        const tagMatch = part.match(/^([a-zA-Z0-9_-]+)?(?:\[(.*?)\])?/);
        if (!tagMatch) throw new Error(`Invalid selector part: ${part}`);
        
        const tag = tagMatch[1];
        const rawArg = tagMatch[2];

        // Text nodes carry no [args] — hard-error instead of silently matching
        // all text nodes (dev log 91 F1-b; same rule as parseSelectorPart).
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

        const pseudoString = part.substring(tagMatch[0].length);
        const pseudos = parsePseudoClasses(pseudoString);

        if (pseudos.length > 0 && !tag) {
          throw new Error(
            "Pseudo-classes must follow a tag. Use layout, inset, or property before pseudo-classes."
          );
        }

        const sp: SelectorPart = { tag, argExact, pseudos };
        // First part of each ~ group after the first gets sibling combinator
        if (gi > 0 && pi === 0) sp.combinator = "sibling";
        allParts.push(sp);
      }
    }
    
    return allParts;
  });
}

function nodeContainsText(node: Node, searchStr: string): boolean {
  if (node.type === "text") {
    return node.text.includes(searchStr);
  } else if (node.type === "block") {
    // Use shared concatenation utility so phrases spanning
    // punctuation-induced text-node boundaries match. Selectors see ALL text,
    // including \change_deleted (a selector locates nodes; mutations --find /
    // split-after see only current text — dev log 87 D7).
    const { fullText } = concatenateTextNodes(node.children, { includeDeleted: true });
    if (fullText.includes(searchStr)) return true;
    // Also recurse into sub-blocks (insets, nested layouts)
    for (const child of node.children) {
      if (child.type === "block" && nodeContainsText(child, searchStr)) {
        return true;
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

/** Does a block contain any text under the given style state? (:property() on blocks.) */
function blockContainsProperty(node: BlockNode, prop: PropertyArg): boolean {
  let found = false;
  const walk = (list: Node[]) => {
    if (found) return;
    const state: Record<string, string | undefined> = {};
    for (const c of list) {
      if (found) return;
      if (c.type === "text") {
        if (matchesProperty(state[prop.key], prop)) {
          found = true;
          return;
        }
      } else if (c.type === "property" && isInlineStyleKey(c.key)) {
        state[c.key] = c.value;
      } else if (c.type === "block") {
        walk((c as BlockNode).children);
      }
    }
  };
  walk(node.children);
  return found;
}

/** Does a block contain any text sitting in the given region? (:change() on layouts.) */
function blockContainsRegion(node: BlockNode, want: "current" | "inserted" | "deleted"): boolean {
  let found = false;
  const walk = (list: Node[]) => {
    if (found) return;
    let deletedDepth = 0;
    let insertedDepth = 0;
    for (const c of list) {
      if (found) return;
      if (c.type === "text") {
        const region = deletedDepth > 0 ? "deleted" : insertedDepth > 0 ? "inserted" : "current";
        if (region === want) {
          found = true;
          return;
        }
      } else if (c.type === "property" && isChangeMarkerKey(c.key)) {
        const d = advanceChangeDepths(c.key, deletedDepth, insertedDepth);
        deletedDepth = d.deletedDepth;
        insertedDepth = d.insertedDepth;
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
          if (!nodeContainsText(node, val)) {
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
          const matches = findDescendants(node.children, innerPart);
          if (matches.length > 0) return false;
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
          if (!sitsInParent && !blockContainsRegion(node, want)) return false;
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
          if (!sitsInParent && !blockContainsProperty(node, prop)) return false;
        } else {
          return false;
        }
      }
    }
  }

  return true;
}

function findDescendants(nodes: Node[], part: SelectorPart, results: Node[] = []): Node[] {
  let deletedDepth = 0;
  let insertedDepth = 0;
  const propState: Record<string, string | undefined> = {};
  for (const node of nodes) {
    const region: "deleted" | "inserted" | "current" =
      deletedDepth > 0 ? "deleted" : insertedDepth > 0 ? "inserted" : "current";
    if (matchNode(node, part, region, propState)) {
      results.push(node);
    }
    if (node.type === "block") {
      findDescendants(node.children, part, results);
    }
    if (node.type === "property" && isChangeMarkerKey(node.key)) {
      const d = advanceChangeDepths(node.key, deletedDepth, insertedDepth);
      deletedDepth = d.deletedDepth;
      insertedDepth = d.insertedDepth;
    } else if (node.type === "property" && isInlineStyleKey(node.key)) {
      propState[node.key] = node.value;
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
 * Find all following siblings of the given anchor node that match `part`.
 * Used by the ~ (general sibling) combinator.
 * If parentIndex is provided, uses it for O(1) anchor lookup instead of O(n) tree walk.
 */
function findFollowingSiblings(
  anchor: Node,
  rootChildren: Node[],
  part: SelectorPart,
  parentIndex?: Map<Node, { parentChildren: Node[]; index: number }>,
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
    if (matchNode(sibling, part, regionAt(ctx.parentChildren, i), propertyStateAt(ctx.parentChildren, i))) {
      results.push(sibling);
    }
    // Also search descendants of sibling blocks (like space combinator does)
    if (sibling.type === "block") {
      findDescendants(sibling.children, part, results);
    }
  }
  return results;
}

/**
 * Check if any node in the range (parentChildren, from startIndex, up to but
 * not including the given node) matches `innerPart`.  Used by :until().
 */
function hasInterveningMatch(
  node: Node,
  parentChildren: Node[],
  startIndex: number,
  innerPart: SelectorPart,
): boolean {
  for (let i = startIndex; i < parentChildren.length; i++) {
    if (parentChildren[i] === node) return false; // reached target, no match found
    if (matchNode(parentChildren[i], innerPart, regionAt(parentChildren, i), propertyStateAt(parentChildren, i))) return true;
    // Also check descendants of intervening blocks
    if (parentChildren[i].type === "block") {
      const descMatches = findDescendants((parentChildren[i] as BlockNode).children, innerPart);
      if (descMatches.length > 0) return true;
    }
  }
  return false;
}

export function query(ast: DocumentNode, selectorStr: string): Node[] {
  const groups = parseSelector(selectorStr);
  const rootChildren = ast.type === "document" ? ast.children : (ast.type === "block" ? ast.children : []);
  
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
  
  const finalResults = new Set<Node>();

  for (const group of groups) {
    let currentNodes: Node[] = rootChildren;
    // Track the anchor nodes for :until() bounding — each anchor corresponds
    // to a node matched in the previous stage (before the ~ combinator).
    let siblingAnchors: Node[] = [];

    for (let i = 0; i < group.length; i++) {
      const part = group[i];
      let nextNodes: Node[] = [];

      if (part.combinator === "sibling") {
        // ~ combinator: search following siblings of each current anchor
        for (const cn of currentNodes) {
          nextNodes = nextNodes.concat(findFollowingSiblings(cn, rootChildren, part, parentIndex));
        }
        // Save current nodes as anchors for potential :until() filtering
        siblingAnchors = currentNodes;
      } else if (i === 0) {
        nextNodes = findDescendants(currentNodes, part);
      } else {
        for (const cn of currentNodes) {
          if (cn.type === "block") {
            nextNodes = nextNodes.concat(findDescendants(cn.children, part));
          }
        }
      }

      // Apply pseudo-classes (first, last, nth, nth-child, adjacent, contains, not, until)
      if (part.pseudos) {
        for (const p of part.pseudos) {
          if (p.name === "first" && nextNodes.length > 0) {
            nextNodes = [nextNodes[0]];
          } else if (p.name === "last" && nextNodes.length > 0) {
            nextNodes = [nextNodes[nextNodes.length - 1]];
          } else if (p.name === "nth-child" && p.argRaw !== undefined) {
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
                return matchNode(prev, innerPart, regionAt(ctx.parentChildren, si), propertyStateAt(ctx.parentChildren, si));
              }
              return false;
            });
          } else if (p.name === "until" && p.argRaw !== undefined) {
            // :until(selector) — rejects nodes that have a sibling matching
            // the inner selector between them and the ~ anchor.
            const innerPart = parseSelectorPart(p.argRaw, true);
            if (siblingAnchors.length > 0) {
              // Build a map: anchor -> set of nodes bounded by it
              nextNodes = nextNodes.filter(n => {
                // Find which anchor this node belongs to
                const nCtx = getSiblingContextFast(n, rootChildren, parentIndex);
                if (!nCtx) return false;
                // Find nearest anchor that precedes this node
                for (let ai = siblingAnchors.length - 1; ai >= 0; ai--) {
                  const anchorCtx = getSiblingContextFast(siblingAnchors[ai], rootChildren, parentIndex);
                  if (!anchorCtx) continue;
                  if (anchorCtx.parentChildren !== nCtx.parentChildren) continue;
                  if (anchorCtx.index < nCtx.index) {
                    // Check for intervening match
                    return !hasInterveningMatch(n, nCtx.parentChildren, anchorCtx.index + 1, innerPart);
                  }
                }
                return true; // no anchor found, keep node
              });
            }
            // If no sibling anchors (e.g. :until() used without ~), the filter
            // has no effect — all nodes pass through.
            if (siblingAnchors.length === 0) {
              // :until() is only meaningful after ~; without it, no filtering occurs.
            }
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
