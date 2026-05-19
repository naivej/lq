import { DocumentNode, Node } from "./ast.ts";

export interface PseudoClass {
  name: "first" | "last" | "nth" | "contains" | "nth-child";
  argRaw?: string;
}

export interface SelectorPart {
  tag?: string;      // e.g., 'layout', 'inset'
  argExact?: string; // e.g., 'Section' inside [Section]
  pseudos?: PseudoClass[];
}

export type Selector = SelectorPart[][]; // Array of paths, where each path is an array of parts

export function parseSelector(selector: string): SelectorPart[][] {
  return selector.split(",").map((sel) => {
    // Split by whitespace but respect quotes and brackets
    const unquoted = sel.replace(/"[^"]*"/g, "").replace(/'[^']*'/g, "");
    if ((unquoted.match(/\[/g) || []).length !== (unquoted.match(/\]/g) || []).length) throw new Error(`Unclosed bracket in selector part: ${sel}`);
    
    const parts = sel.trim().match(/(?:[^\s"'\[(]+|\[[^\]]*\]|"[^"]*"|'[^']*'|\((?:"[^"]*"|'[^']*'|[^)(]+)*\))+/g) || [];
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
      const pseudos: PseudoClass[] = [];
      
      if (pseudoString) {
        // Match pseudo-classes. Ensure string literals ("..." and '...') are checked BEFORE [^)(]+ 
        // to prevent the negation class from prematurely swallowing quote markers.
        const pseudoRegex = /:([a-zA-Z0-9_-]+)(?:\(((?:"[^"]*"|'[^']*'|[^)(]+)*)\))?/g;
        let pMatch;
        let matchedLength = 0;
        while ((pMatch = pseudoRegex.exec(pseudoString)) !== null) {
          const pName = pMatch[1];
          const pArg = pMatch[2] ? pMatch[2].trim() : undefined;
          
          if (!["first", "last", "nth", "nth-child", "contains"].includes(pName)) {
            throw new Error(`Unsupported pseudo-class: :${pName}`);
          }
          
          pseudos.push({ name: pName as "first" | "last" | "nth" | "contains" | "nth-child", argRaw: pArg });
          matchedLength += pMatch[0].length;
        }
        
        if (matchedLength !== pseudoString.length) {
          throw new Error(`Invalid pseudo-class syntax in part: ${part}`);
        }
      }

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
    }
  }

  return true;
}

function findDescendants(nodes: Node[], part: SelectorPart): Node[] {
  let results: Node[] = [];

  for (const node of nodes) {
    if (matchNode(node, part)) {
      results.push(node);
    }
    if (node.type === "block") {
      results = results.concat(findDescendants(node.children, part));
    }
  }

  return results;
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
