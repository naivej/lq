import { basename, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { AdapterError, PreviewSession } from "./previewSession";
import { discoverLqBinary, runLivePreview } from "./lqClient";
import { getCachedNavigate, getCachedOutline, rememberOutline } from "./outlineProvider";
import {
  attachApproxLines,
  attachNavigateLines,
  dedupeNavigateLabels,
  scanLyxHeadingLines,
} from "./outlineNest";
import { LyxOutlineTreeProvider } from "./outlineTree";
import { renderWebviewHtml } from "./webview";

const VIEW_TYPE = "lyxPreview.live";

class LivePreviewPanel {
  private static current: LivePreviewPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly session = new PreviewSession();
  private pending = false;
  private diskTimer: ReturnType<typeof setTimeout> | undefined;
  /** Stable path identity for this preview (Windows-safe). */
  private readonly filePath: string;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private document: vscode.TextDocument,
    private readonly outlineTree: LyxOutlineTreeProvider,
  ) {
    this.filePath = normalizeFsPath(document.uri.fsPath);
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.disposables.push(vscode.workspace.onDidSaveTextDocument((saved) => {
      if (!sameFsPath(saved.uri.fsPath, this.filePath)) return;
      this.document = saved;
      void this.refresh();
    }));

    this.disposables.push(vscode.workspace.onDidChangeTextDocument((change) => {
      if (!sameFsPath(change.document.uri.fsPath, this.filePath)) return;
      this.document = change.document;
      if (change.contentChanges.length === 0) return;
      this.session.markStale();
      this.paint();
    }));

    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(dirname(this.filePath)), basename(this.filePath)),
    );
    this.disposables.push(watcher);
    const scheduleDiskRefresh = () => {
      if (this.diskTimer) clearTimeout(this.diskTimer);
      this.diskTimer = setTimeout(() => {
        this.diskTimer = undefined;
        if (this.isOpenDocDirty()) return;
        void this.refresh();
      }, 150);
    };
    watcher.onDidChange(scheduleDiskRefresh, this, this.disposables);
    watcher.onDidCreate(scheduleDiskRefresh, this, this.disposables);
    watcher.onDidDelete(scheduleDiskRefresh, this, this.disposables);

    this.paint();
    void this.refresh();
  }

  static createOrShow(
    document: vscode.TextDocument,
    outlineTree: LyxOutlineTreeProvider,
  ): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Beside;
    if (LivePreviewPanel.current) {
      LivePreviewPanel.current.panel.reveal(column);
      if (!sameFsPath(LivePreviewPanel.current.filePath, document.uri.fsPath)) {
        LivePreviewPanel.current.dispose();
        LivePreviewPanel.createOrShow(document, outlineTree);
        return;
      }
      LivePreviewPanel.current.document = document;
      void LivePreviewPanel.current.refresh();
      return;
    }
    const roots = new Map<string, vscode.Uri>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      roots.set(folder.uri.toString(), folder.uri);
    }
    roots.set(document.uri.toString(), vscode.Uri.file(dirname(document.uri.fsPath)));
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      titleFor(document),
      column,
      {
        enableScripts: true,
        enableFindWidget: true,
        retainContextWhenHidden: true,
        localResourceRoots: [...roots.values()],
      },
    );
    LivePreviewPanel.current = new LivePreviewPanel(panel, document, outlineTree);
  }

  /** Scroll Live Preview to heading id (focus unchanged). */
  static scrollToId(id: string): void {
    LivePreviewPanel.current?.postScrollToId(id);
  }

  /**
   * Scroll a visible .lyx editor to `line` without focusing it.
   * Never calls showTextDocument / never sets selection (both steal focus).
   */
  static revealSourceLine(line: number | undefined): void {
    const cur = LivePreviewPanel.current;
    if (!cur || typeof line !== "number" || !Number.isFinite(line)) return;
    const doc = cur.document;
    const safe = Math.max(0, Math.min(Math.floor(line), Math.max(0, doc.lineCount - 1)));
    const range = doc.lineAt(safe).range;
    const visible = vscode.window.visibleTextEditors.find((ed) =>
      sameFsPath(ed.document.uri.fsPath, doc.uri.fsPath)
    );
    if (!visible) return;
    visible.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private postScrollToId(id: string): void {
    if (!id) return;
    void this.panel.webview.postMessage({ type: "scrollToId", id });
  }

  private isOpenDocDirty(): boolean {
    const open = vscode.workspace.textDocuments.find((d) => sameFsPath(d.uri.fsPath, this.filePath));
    return open?.isDirty ?? false;
  }

  private publishOutline(
    entries: { level: number; number: string; text: string; id: string }[],
    navigate?: import("./previewSession").LiveNavigate,
  ): void {
    const lines = this.document.getText().split(/\r?\n/);
    const withLines = attachApproxLines(entries, lines);
    const rawNav = navigate ?? this.session.lastValid?.navigate;
    const nav = rawNav
      ? attachNavigateLines(dedupeNavigateLabels(rawNav, withLines), lines)
      : undefined;
    rememberOutline(this.filePath, entries, nav);
    this.outlineTree.refresh(this.filePath, withLines, nav);
  }

  private async refresh(): Promise<void> {
    const generation = this.session.nextGeneration();
    this.pending = true;
    this.paint();
    const timeoutMs = vscode.workspace.getConfiguration("lyx-preview", this.document.uri).get<number>("timeoutMs") ?? 30000;
    try {
      const lqPath = discoverLqBinary(this.document.uri);
      const render = await runLivePreview(lqPath, this.filePath, timeoutMs);
      if (generation !== this.session.generation) return;
      if (!this.session.applySuccess(generation, render)) return;
      this.publishOutline(render.outline, render.navigate);
      this.pending = false;
      this.paint();
    } catch (error) {
      if (generation !== this.session.generation) return;
      if (!this.session.applyFailure(generation)) return;
      this.pending = false;
      // Still populate Explorer outline from the buffer when lq fails.
      this.publishOutline(scanLyxHeadingLines(this.document.getText().split(/\r?\n/)), undefined);
      const message = error instanceof AdapterError
        ? error.message
        : error instanceof Error ? error.message : String(error);
      this.paint(message);
    }
  }

  private paint(error?: string): void {
    this.panel.title = titleFor(this.document);
    const html = this.session.lastValid
      ? rewriteLocalImages(this.session.lastValid.html, this.panel.webview)
      : undefined;
    const render = this.session.lastValid && html
      ? { ...this.session.lastValid, html }
      : this.session.lastValid;
    const bust = render?.source.diskHash ?? `err-${Date.now()}`;
    const nonce = randomBytes(16).toString("base64url");
    this.panel.webview.html = renderWebviewHtml({
      title: this.panel.title,
      stale: this.session.stale,
      pending: this.pending,
      error,
      render,
      imgCsp: `${this.panel.webview.cspSource} data:`,
      scriptNonce: nonce,
      scriptCsp: `'nonce-${nonce}'`,
    }).replace("<head>", `<head>\n<!-- lyx-live ${bust} -->`);
  }

  private dispose(): void {
    if (this.diskTimer) clearTimeout(this.diskTimer);
    if (LivePreviewPanel.current === this) LivePreviewPanel.current = undefined;
    this.outlineTree.clear();
    for (const d of this.disposables) d.dispose();
  }
}

function normalizeFsPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function sameFsPath(a: string, b: string): boolean {
  const na = normalizeFsPath(a);
  const nb = normalizeFsPath(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function rewriteLocalImages(html: string, webview: vscode.Webview): string {
  return html.replace(/<img\b[^>]*>/gi, (tag) => {
    const fp = /data-filepath="([^"]*)"/.exec(tag)?.[1];
    if (!fp) return tag;
    const decoded = fp.replaceAll("&amp;", "&");
    const uri = webview.asWebviewUri(vscode.Uri.file(decoded)).toString();
    if (/\ssrc="/.test(tag)) return tag.replace(/\ssrc="[^"]*"/, ` src="${uri}"`);
    return tag.replace("<img", `<img src="${uri}"`);
  });
}

function titleFor(document: vscode.TextDocument): string {
  const name = document.fileName.split(/[/\\]/).pop() ?? document.fileName;
  return `LyX Live: ${name}`;
}

export function activate(context: vscode.ExtensionContext): void {
  const outlineTree = new LyxOutlineTreeProvider();
  const treeView = vscode.window.createTreeView("lyxPreview.outline", {
    treeDataProvider: outlineTree,
    showCollapseAll: true,
  });

  /** Prefer Live outline/navigate ids (match preview HTML); fall back to buffer scan. */
  const refreshTreeForDoc = (doc: vscode.TextDocument | undefined) => {
    if (!doc || !doc.fileName.toLowerCase().endsWith(".lyx")) return;
    const lines = doc.getText().split(/\r?\n/);
    const live = getCachedOutline(doc.uri.fsPath);
    const outline = live && live.length > 0
      ? attachApproxLines(live, lines)
      : scanLyxHeadingLines(lines);
    const cachedNav = getCachedNavigate(doc.uri.fsPath);
    const navigate = cachedNav
      ? attachNavigateLines(dedupeNavigateLabels(cachedNav, outline), lines)
      : undefined;
    outlineTree.refresh(doc.uri.fsPath, outline, navigate);
  };

  context.subscriptions.push(
    treeView,
    vscode.commands.registerCommand("lyx-preview.open", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !editor.document.fileName.toLowerCase().endsWith(".lyx")) {
        void vscode.window.showWarningMessage("Open a .lyx document before starting LyX Live Preview.");
        return;
      }
      LivePreviewPanel.createOrShow(editor.document, outlineTree);
    }),
    vscode.commands.registerCommand(
      "lyx-preview.revealOutline",
      async (id: string, line?: number) => {
        LivePreviewPanel.scrollToId(id);
        LivePreviewPanel.revealSourceLine(line);
        // TreeItem commands can still move focus; put it back on LyX Outline.
        await vscode.commands.executeCommand("lyxPreview.outline.focus");
      },
    ),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      // Do not replace Live ids with scan slugs when a preview cache exists.
      refreshTreeForDoc(ed?.document);
    }),
  );

  refreshTreeForDoc(vscode.window.activeTextEditor?.document);
}

export function deactivate(): void {
  // Webview panels dispose through VS Code.
}
