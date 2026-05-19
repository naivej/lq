import { BlockNode, DocumentNode, PropertyNode, TextNode } from "./ast.ts";

export function parse(text: string, isSnippet = false): DocumentNode {
  if (!isSnippet && !text.trim().startsWith("#LyX")) {
    throw new Error("Invalid LyX file format. Expected '#LyX' header.");
  }
  const lines = text.split(/\r?\n/);
  const root: DocumentNode = { type: "document", children: [] };
  const stack: BlockNode[] = [];

  let inOpaqueBlock = false;
  let opaqueTag = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (inOpaqueBlock) {
      if (line === `\\end_${opaqueTag}`) {
        inOpaqueBlock = false;
        stack.pop();
      } else {
        stack[stack.length - 1].children.push({ type: "text", text: line });
      }
      continue;
    }

    const beginMatch = line.match(/^\\begin_([a-zA-Z0-9_]+)(?:\s+(.*))?$/);
    if (beginMatch) {
      const tag = beginMatch[1];
      const args = beginMatch[2];
      const block: BlockNode = { type: "block", tag, args, isBeginVariant: true, children: [] };
      
      if (stack.length > 0) {
        stack[stack.length - 1].children.push(block);
      } else {
        root.children.push(block);
      }
      stack.push(block);

      if (tag === "preamble" || (tag === "inset" && (args === "Formula" || args === "ERT"))) {
        inOpaqueBlock = true;
        opaqueTag = tag;
      }
      continue;
    }

    const endMatch = line.match(/^\\end_([a-zA-Z0-9_]+)$/);
    if (endMatch) {
      const tag = endMatch[1];
      if (stack.length === 0 || stack[stack.length - 1].tag !== tag) {
        throw new Error(`Mismatched end tag: expected ${stack[stack.length - 1]?.tag}, got ${tag} at line ${i}`);
      }
      stack.pop();
      continue;
    }

    const propMatch = line.match(/^\\([a-zA-Z0-9_]+)(?:\s+(.*))?$/);
    if (propMatch) {
      const key = propMatch[1];
      const value = propMatch[2];
      
      // Handle special LyX blocks that don't use the \begin_ prefix
      if (key === "index" || key === "branch" || key === "modules") {
        const block: BlockNode = { type: "block", tag: key, args: value, isBeginVariant: false, children: [] };
        if (stack.length > 0) {
          stack[stack.length - 1].children.push(block);
        } else {
          root.children.push(block);
        }
        stack.push(block);
        continue;
      }

      const prop: PropertyNode = { type: "property", key, value };
      if (stack.length > 0) {
        stack[stack.length - 1].children.push(prop);
      } else {
        root.children.push(prop);
      }
      continue;
    }

    const textNode: TextNode = { type: "text", text: line };
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(textNode);
    } else {
      root.children.push(textNode);
    }
  }

  if (stack.length > 0) {
    throw new Error(`Unclosed tag: ${stack[stack.length - 1].tag}`);
  }

  return root;
}
