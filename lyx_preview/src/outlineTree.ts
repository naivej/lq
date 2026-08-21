/**
 * Explorer "LyX Navigate" tree: Outline / Figures / Tables / Equations / Labels / …
 *
 * Children are resolved by TreeItem.id (not `element.node`) so VS Code refresh/restore
 * cannot hit `Cannot read properties of undefined (reading 'type')`.
 */

import * as vscode from "vscode";
import type { LiveNavEntry, LiveNavigate, LiveOutlineEntry } from "./previewSession";
import { emptyNavigate } from "./previewSession";
import { nestOutlineEntries, type NestedOutline, type OutlineEntryLike } from "./outlineNest";

export type NavNode =
  | { type: "group"; key: string; label: string; children: NavNode[] }
  | { type: "heading"; entry: OutlineEntryLike; nested: NestedOutline }
  | { type: "item"; entry: LiveNavEntry };

function nodeId(node: NavNode): string {
  if (node.type === "group") return `group:${node.key}`;
  if (node.type === "heading") return `h:${node.entry.id}`;
  return `i:${node.entry.kind}:${node.entry.id}:${node.entry.name ?? ""}`;
}

function group(key: string, label: string, children: NavNode[]): NavNode | undefined {
  if (children.length === 0) return undefined;
  return { type: "group", key, label, children };
}

function asNavArray(v: LiveNavEntry[] | undefined): LiveNavEntry[] {
  return Array.isArray(v) ? v.filter((e) => e && typeof e.id === "string") : [];
}

function normalizeNavigate(navigate: LiveNavigate | undefined): LiveNavigate {
  if (!navigate) return emptyNavigate();
  return {
    figures: asNavArray(navigate.figures),
    tables: asNavArray(navigate.tables),
    equations: asNavArray(navigate.equations),
    labels: asNavArray(navigate.labels),
    listings: asNavArray(navigate.listings),
    algorithms: asNavArray(navigate.algorithms),
  };
}

export function buildNavigateRoots(
  outline: OutlineEntryLike[] | undefined,
  navigate: LiveNavigate | undefined,
): NavNode[] {
  const headings = Array.isArray(outline) ? outline.filter(Boolean) : [];
  const headingRoots = nestOutlineEntries(headings).map((n): NavNode => ({
    type: "heading",
    entry: n.entry,
    nested: n,
  }));
  const item = (e: LiveNavEntry): NavNode => ({ type: "item", entry: e });
  const roots: NavNode[] = [];
  const outlineGroup = group("outline", "Outline", headingRoots);
  if (outlineGroup) roots.push(outlineGroup);
  const nav = normalizeNavigate(navigate);
  for (
    const g of [
      group("figures", "List of Figures", nav.figures.map(item)),
      group("tables", "List of Tables", nav.tables.map(item)),
      group("equations", "List of Equations", nav.equations.map(item)),
      group("listings", "List of Listings", nav.listings.map(item)),
      group("algorithms", "List of Algorithms", nav.algorithms.map(item)),
      group("labels", "Labels", nav.labels.map(item)),
    ]
  ) {
    if (g) roots.push(g);
  }
  return roots;
}

function childNodes(node: NavNode): NavNode[] {
  if (node.type === "group") return node.children;
  if (node.type === "heading") {
    return node.nested.children.map((n) => ({
      type: "heading" as const,
      entry: n.entry,
      nested: n,
    }));
  }
  return [];
}

export class NavigateTreeItem extends vscode.TreeItem {
  constructor(node: NavNode) {
    // super() must run before touching `this`; branch on node.type first.
    if (node.type === "group") {
      super(node.label, vscode.TreeItemCollapsibleState.Expanded);
      this.iconPath = new vscode.ThemeIcon(
        node.key === "outline"
          ? "list-tree"
          : node.key === "labels"
          ? "tag"
          : node.key === "equations"
          ? "symbol-number"
          : "symbol-misc",
      );
      this.contextValue = "lyxNavGroup";
    } else if (node.type === "heading") {
      super(
        node.nested.name,
        node.nested.children.length > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None,
      );
      this.description = node.entry.id;
      this.iconPath = new vscode.ThemeIcon("symbol-namespace");
      this.command = {
        command: "lyx-preview.revealOutline",
        title: "Reveal",
        arguments: [node.entry.id, node.entry.line],
      };
    } else {
      const e = node.entry;
      const label = e.number
        ? (e.text ? `${e.number} ${e.text}` : e.number)
        : (e.name || e.text || e.id);
      super(label, vscode.TreeItemCollapsibleState.None);
      this.description = e.name ? `${e.name} → #${e.id}` : `#${e.id}`;
      this.iconPath = new vscode.ThemeIcon(
        e.kind === "figure"
          ? "file-media"
          : e.kind === "table"
          ? "table"
          : e.kind === "equation"
          ? "symbol-number"
          : e.kind === "label"
          ? "tag"
          : "symbol-misc",
      );
      this.command = {
        command: "lyx-preview.revealOutline",
        title: "Reveal",
        arguments: [e.id, e.line],
      };
    }
    this.id = nodeId(node);
  }
}

export class LyxOutlineTreeProvider implements vscode.TreeDataProvider<NavigateTreeItem> {
  private readonly _onDidChange = new vscode.EventEmitter<NavigateTreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChange.event;
  private outline: OutlineEntryLike[] = [];
  private navigate: LiveNavigate = emptyNavigate();
  /** Stable id → node, so getChildren works after VS Code drops custom fields. */
  private readonly nodesById = new Map<string, NavNode>();

  refresh(
    _filePath: string | undefined,
    outline: OutlineEntryLike[],
    navigate?: LiveNavigate,
  ): void {
    this.outline = Array.isArray(outline) ? outline : [];
    this.navigate = normalizeNavigate(navigate);
    this.nodesById.clear();
    const register = (n: NavNode) => {
      this.nodesById.set(nodeId(n), n);
      for (const c of childNodes(n)) register(c);
    };
    for (const r of buildNavigateRoots(this.outline, this.navigate)) register(r);
    const has = this.nodesById.size > 0;
    void vscode.commands.executeCommand("setContext", "lyxPreview.hasOutline", has);
    this._onDidChange.fire(undefined);
  }

  clear(): void {
    this.refresh(undefined, [], undefined);
  }

  getTreeItem(element: NavigateTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: NavigateTreeItem): NavigateTreeItem[] {
    if (!element) {
      return buildNavigateRoots(this.outline, this.navigate).map((n) => new NavigateTreeItem(n));
    }
    const id = element.id;
    if (!id) return [];
    const node = this.nodesById.get(id);
    if (!node) return [];
    return childNodes(node).map((n) => new NavigateTreeItem(n));
  }
}

export type { LiveNavEntry, LiveNavigate, LiveOutlineEntry };
