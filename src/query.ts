import { DocumentNode, Node, BlockNode } from "./ast.ts";

export interface PseudoClass {
  name: "first" | "last" | "nth" | "contains" | "nth-child" | "not" | "adjacent";
  argRaw?: string;
}

export interface SelectorPart {
  tag?: string;      // e.g., 'layout', 'inset'
  argExact?: string; // e.g., 'Section' inside [Section]
  pseudos?: PseudoClass[];
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

    if (!["first", "last", "nth", "nth-child", "contains", "not", "adjacent"].includes(pName)) {
      throw new Error(`Unsupported pseudo-class: :${pName}`);
    }

    if (pName === "not" || pName === "adjacent") {
      if (!pArg) throw new Error(`:${pName}() requires a selector argument, e.g. :${pName}(layout[Section])`);
      try { parseSelectorPart(pArg); } catch {
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

/** Parse a single selector part string (e.g. "inset[CommandInset bibtex]") into a SelectorPart. */
function parseSelectorPart(raw: string): SelectorPart {
  const tagMatch = raw.match(/^([a-zA-Z0-9_-]+)?(?:\[(.*?)\])?/);
  if (!tagMatch) throw new Error(`Invalid selector: ${raw}`);

  const tag = tagMatch[1];
  const rawArg = tagMatch[2];

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

  return { tag, argExact, pseudos: pseudos.length > 0 ? pseudos : undefined };
}

/** Split a selector string by whitespace, respecting brackets, quotes, and paren depth. */
function splitSelectorByWhitespace(sel: string): string[] {
  const parts: string[] = [];
  let current = "";
  let parenDepth = 0;
  let inBracket = false;
  let inDoubleQuote = false;
  let inSingleQuote = false;

  for (let i = 0; i < sel.length; i++) {
    const ch = sel[i];
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
    } else if (ch === ' ' || ch === '\t' || ch === '\n') {
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

export function parseSelector(selector: string): SelectorPart[][] {
  return selector.split(",").map((sel) => {
    // Validate bracket balance
    const unquoted = sel.replace(/"[^"]*"/g, "").replace(/'[^']*'/g, "");
    if ((unquoted.match(/\[/g) || []).length !== (unquoted.match(/\]/g) || []).length) throw new Error(`Unclosed bracket in selector part: ${sel}`);
    
    // Split by whitespace, respecting brackets, quotes, and paren depth.
    const parts = splitSelectorByWhitespace(sel.trim());
    return parts.map((part) => {
      const tagMatch = part.match(/^([a-zA-Z0-9_-]+)?(?:\[(.*?)\])?/);
      if (!tagMatch) throw new Error(`Invalid selector part: ${part}`);
      
      const tag = tagMatch[1];
      const rawArg = tagMatch[2];

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

      return { tag, argExact, pseudos };
    });
  });
}

function nodeContainsText(node: Node, searchStr: string): boolean {
  if (node.type === "text") {
    return node.text.includes(searchStr);
  } else if (node.type === "block") {
    for (const child of node.children) {
      if (nodeContainsText(child, searchStr)) {
        return true;
      }
    }
  }
  return false;
}

function matchNode(node: Node, part: SelectorPart): boolean {
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
        // Parse the inner selector as a SelectorPart.
        const innerPart = parseSelectorPart(p.argRaw);
        if (node.type === "block") {
          const matches = findDescendants(node.children, innerPart);
          if (matches.length > 0) return false;
        }
        // For non-block nodes, :not() always passes (there are no descendants to check).
      }
    }
  }

  return true;
}

function findDescendants(nodes: Node[], part: SelectorPart, results: Node[] = []): Node[] {
  for (const node of nodes) {
    if (matchNode(node, part)) {
      results.push(node);
    }
    if (node.type === "block") {
      findDescendants(node.children, part, results);
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

export function query(ast: DocumentNode, selectorStr: string): Node[] {
  const groups = parseSelector(selectorStr);
  const rootChildren = ast.type === "document" ? ast.children : (ast.type === "block" ? ast.children : []);
  
  const finalResults = new Set<Node>();

  for (const group of groups) {
    let currentNodes: Node[] = rootChildren;

    for (let i = 0; i < group.length; i++) {
      const part = group[i];
      let nextNodes: Node[] = [];

      // If it's the first part in a group, search from root
      // Otherwise, search descendants of current matches
      if (i === 0) {
        nextNodes = findDescendants(currentNodes, part);
      } else {
        for (const cn of currentNodes) {
          if (cn.type === "block") {
            nextNodes = nextNodes.concat(findDescendants(cn.children, part));
          }
        }
      }

      // Apply pseudo-classes
      if (part.pseudos) {
        for (const p of part.pseudos) {
          if (p.name === "first" && nextNodes.length > 0) {
            nextNodes = [nextNodes[0]];
          } else if (p.name === "last" && nextNodes.length > 0) {
            nextNodes = [nextNodes[nextNodes.length - 1]];
          } else if ((p.name === "nth" || p.name === "nth-child") && p.argRaw !== undefined) {
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
            // :adjacent(selector) — keep nodes whose immediately preceding sibling
            // matches the inner selector. Applied as a post-filter like :first/:last.
            const innerPart = parseSelectorPart(p.argRaw);
            nextNodes = nextNodes.filter(n => {
              const ctx = getSiblingContext(n, rootChildren);
              if (!ctx || ctx.index === 0) return false;
              // Skip past text and property nodes to find the previous "meaningful"
              // sibling — the CST has whitespace text nodes between layouts.
              for (let si = ctx.index - 1; si >= 0; si--) {
                const prev = ctx.parentChildren[si];
                if (prev.type === "text" || prev.type === "property") continue;
                return matchNode(prev, innerPart);
              }
              return false;
            });
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
