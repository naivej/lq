/**
 * Explorer "LyX Outline" tree: Table of Contents / Figures / Tables / Equations / …
 *
 * Children are resolved by TreeItem.id (not `element.node`) so VS Code refresh/restore
 * cannot hit `Cannot read properties of undefined (reading 'type')`.
 */

import * as vscode from "vscode";
import {
  formatChangeTime,
  type LiveChangeEntry,
  type LiveNavEntry,
  type LiveNavigate,
  type LiveOutlineEntry,
} from "./previewSession";
import { emptyNavigate } from "./previewSession";
import {
  buildNavigateRoots,
  type NavNode,
  type OutlineEntryLike,
} from "./outlineNest";

function nodeId(node: NavNode): string {
  if (node.type === "group") return `group:${node.key}`;
  if (node.type === "heading") return `h:${node.entry.id}`;
  if (node.type === "change") return `c:${node.entry.anchorId}`;
  return `i:${node.entry.kind}:${node.entry.id}:${node.entry.name ?? ""}`;
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
  if (node.type === "item") {
    return (node.entry.children ?? []).map((e) => ({ type: "item" as const, entry: e }));
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
          : node.key === "changes"
          ? "diff"
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
    } else if (node.type === "change") {
      const e = node.entry;
      const verb = e.type === "inserted" ? "Insert" : "Delete";
      super(
        `${e.ordinal} ${verb} — ${e.snippet}`,
        vscode.TreeItemCollapsibleState.None,
      );
      const time = formatChangeTime(e.ts);
      this.description = time ? `${e.author} · ${time}` : e.author;
      this.iconPath = new vscode.ThemeIcon(
        e.type === "inserted" ? "diff-added" : "diff-removed",
      );
      this.command = {
        command: "lyx-preview.revealOutline",
        title: "Reveal Change",
        arguments: [e.anchorId],
      };
    } else {
      const e = node.entry;
      const label = e.number
        ? (e.text ? `${e.number} ${e.text}` : e.number)
        : (e.name || e.text || e.id);
      const hasKids = (e.children?.length ?? 0) > 0;
      super(
        label,
        hasKids
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None,
      );
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
  private changes: LiveChangeEntry[] = [];
  /** Stable id → node, so getChildren works after VS Code drops custom fields. */
  private readonly nodesById = new Map<string, NavNode>();

  refresh(
    _filePath: string | undefined,
    outline: OutlineEntryLike[],
    navigate?: LiveNavigate,
    changes?: LiveChangeEntry[],
  ): void {
    this.outline = Array.isArray(outline) ? outline : [];
    this.navigate = navigate ?? emptyNavigate();
    this.changes = Array.isArray(changes) ? changes : [];
    this.nodesById.clear();
    const register = (n: NavNode) => {
      this.nodesById.set(nodeId(n), n);
      for (const c of childNodes(n)) register(c);
    };
    for (const r of buildNavigateRoots(this.outline, this.navigate, this.changes)) register(r);
    const has = this.nodesById.size > 0;
    void vscode.commands.executeCommand("setContext", "lyxPreview.hasOutline", has);
    this._onDidChange.fire(undefined);
  }

  clear(): void {
    this.refresh(undefined, [], undefined, undefined);
  }

  getTreeItem(element: NavigateTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: NavigateTreeItem): NavigateTreeItem[] {
    if (!element) {
      return buildNavigateRoots(this.outline, this.navigate, this.changes)
        .map((n) => new NavigateTreeItem(n));
    }
    const id = element.id;
    if (!id) return [];
    const node = this.nodesById.get(id);
    if (!node) return [];
    return childNodes(node).map((n) => new NavigateTreeItem(n));
  }
}

export type { LiveNavEntry, LiveNavigate, LiveOutlineEntry };
