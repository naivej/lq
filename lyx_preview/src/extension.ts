import { basename, dirname } from "node:path";
import * as vscode from "vscode";
import { AdapterError, PreviewSession } from "./previewSession";
import { discoverLqBinary, runLivePreview } from "./lqClient";
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

    // Absolute Uri base — string bases are workspace-relative and miss many paths.
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

  static createOrShow(document: vscode.TextDocument): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Beside;
    if (LivePreviewPanel.current) {
      LivePreviewPanel.current.panel.reveal(column);
      if (!sameFsPath(LivePreviewPanel.current.filePath, document.uri.fsPath)) {
        LivePreviewPanel.current.dispose();
        LivePreviewPanel.createOrShow(document);
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
        enableScripts: false,
        enableFindWidget: true,
        retainContextWhenHidden: true,
        localResourceRoots: [...roots.values()],
      },
    );
    LivePreviewPanel.current = new LivePreviewPanel(panel, document);
  }

  private isOpenDocDirty(): boolean {
    const open = vscode.workspace.textDocuments.find((d) => sameFsPath(d.uri.fsPath, this.filePath));
    return open?.isDirty ?? false;
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
      this.pending = false;
      this.paint();
    } catch (error) {
      if (generation !== this.session.generation) return;
      if (!this.session.applyFailure(generation)) return;
      this.pending = false;
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
    // Bust webview cache when content hash changes (VS Code may skip identical html assigns).
    const bust = render?.source.diskHash ?? `err-${Date.now()}`;
    this.panel.webview.html = renderWebviewHtml({
      title: this.panel.title,
      stale: this.session.stale,
      pending: this.pending,
      error,
      render,
      imgCsp: `${this.panel.webview.cspSource} data:`,
    }).replace("<head>", `<head>\n<!-- lyx-live ${bust} -->`);
  }

  private dispose(): void {
    if (this.diskTimer) clearTimeout(this.diskTimer);
    if (LivePreviewPanel.current === this) LivePreviewPanel.current = undefined;
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
  context.subscriptions.push(
    vscode.commands.registerCommand("lyx-preview.open", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !editor.document.fileName.toLowerCase().endsWith(".lyx")) {
        void vscode.window.showWarningMessage("Open a .lyx document before starting LyX Live Preview.");
        return;
      }
      LivePreviewPanel.createOrShow(editor.document);
    }),
  );
}

export function deactivate(): void {
  // Webview panels dispose through VS Code.
}
