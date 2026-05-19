export type Node = BlockNode | PropertyNode | TextNode;

export interface BlockNode {
  type: "block";
  tag: string;
  args?: string;
  isBeginVariant: boolean; // true for \begin_tag, false for \tag
  children: Node[];
}

export interface PropertyNode {
  type: "property";
  key: string;
  value?: string;
}

export interface TextNode {
  type: "text";
  text: string;
}

export interface DocumentNode {
  type: "document";
  children: Node[];
}
