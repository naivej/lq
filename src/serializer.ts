import { DocumentNode, Node } from "./ast.ts";

export function serialize(doc: DocumentNode): string {
  return serializeNodes(doc.children).join("\n");
}

function serializeNodes(nodes: Node[]): string[] {
  const lines: string[] = [];
  for (const node of nodes) {
    if (node.type === "block") {
      if (node.isBeginVariant) {
        lines.push(`\\begin_${node.tag}${node.args !== undefined ? " " + node.args : ""}`);
      } else {
        lines.push(`\\${node.tag}${node.args !== undefined ? " " + node.args : ""}`);
      }
      lines.push(...serializeNodes(node.children));
      lines.push(`\\end_${node.tag}`);
    } else if (node.type === "property") {
      lines.push(`\\${node.key}${node.value !== undefined ? " " + node.value : ""}`);
    } else if (node.type === "text") {
      lines.push(node.text);
    }
  }
  return lines;
}
