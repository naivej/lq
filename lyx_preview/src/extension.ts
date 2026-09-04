import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { normalizeFsPath, sameFsPath } from "./fsPath";
import {
  AdapterError,
  PreviewSession,
  formatChangeTime,
  type LiveChangeEntry,
} from "./previewSession";
import { discoverLqBinary, ensureCompanionLq } from "./lqClient";
import { runLivePreview } from "./lqRunner";
import {
  forgetOutline,
  getCachedChanges,
  getCachedNavigate,
  getCachedOutline,
  rememberOutline,
} from "./outlineProvider";
import { PreviewRoster } from "./previewRoster";
import {
  attachApproxLines,
  attachNavigateLines,
  dedupeNavigateLabels,
  scanLyxHeadingLines,
} from "./outlineNest";
import { LyxOutlineTreeProvider } from "./outlineTree";
import { renderWebviewHtml } from "./webview";
import {
  LM_TOOL_NAME,
  LiveSelectionPersister,
  LiveSelectionStore,
  compactSelector,
  invokeLiveSelection,
  parseSelectMessage,
  resolveLiveSelectionPath,
  type LiveSelectionRecord,
} from "./liveSelection";

const VIEW_TYPE = "lyxPreview.live";

export type ChangeViewMode = "original" | "tracked" | "clean";

const roster = new PreviewRoster();

function selectionBelongsToPreview(
  record: LiveSelectionRecord | undefined,
  previewFile: string,
): boolean {
  if (!record) return false;
  if (sameFsPath(record.file, previewFile)) return true;
  return Boolean(record.via && sameFsPath(record.via.file, previewFile));
}

function setLiveOpenContext(): void {
  void vscode.commands.executeCommand("setContext", "lyxPreview.liveOpen", roster.size > 0);
}

interface LiveSelectionHost {
  selection: LiveSelectionStore;
  persistSelection: (record: LiveSelectionRecord | undefined, previewFile: string) => void;
  onSelectionChange: (record: LiveSelectionRecord | undefined) => void;
}

class LivePreviewPanel {
  private static readonly byPath = new Map<string, LivePreviewPanel>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly session = new PreviewSession();
  private pending = false;
  private webviewReady = false;
  private abort: AbortController | undefined;
  private diskTimer: ReturnType<typeof setTimeout> | undefined;
  /** DL133 per-session view mode: default Tracked, reset when the panel closes. */
  private mode: ChangeViewMode = "tracked";
  /** Stable path identity for this preview (Windows-safe). */
  private readonly filePath: string;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private document: vscode.TextDocument,
    private readonly outlineTree: LyxOutlineTreeProvider,
    private readonly host: LiveSelectionHost,
    private readonly onChangeFocus?: (entry: LiveChangeEntry | undefined) => void,
  ) {
    this.filePath = normalizeFsPath(document.uri.fsPath);
    LivePreviewPanel.byPath.set(this.filePath, this);
    roster.open(this.filePath);
    roster.activatePreview(this.filePath);
    setLiveOpenContext();
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active) {
        roster.activatePreview(this.filePath);
        this.syncOutline();
      } else {
        roster.markPreviewInactive(this.filePath);
      }
    }, null, this.disposables);
    this.panel.webview.onDidReceiveMessage((msg: unknown) => {
      if (msg !== null && typeof msg === "object" && (msg as { type?: unknown }).type === "ready") {
        this.webviewReady = true;
        return;
      }
      if (msg !== null && typeof msg === "object" && (msg as { type?: unknown }).type === "changeFocus") {
        const id = (msg as { id?: unknown }).id;
        const anchorId = typeof id === "string" && id ? id : undefined;
        const entry = anchorId
          ? this.session.lastValid?.changes.find((c) => c.anchorId === anchorId)
          : undefined;
        this.onChangeFocus?.(entry);
      }
      const select = parseSelectMessage(msg);
      if (select) {
        if (select.id === null) {
          this.host.selection.clear();
          this.publishSelection(undefined);
          return;
        }
        const render = this.session.lastValid;
        if (!render) return;
        const record = this.host.selection.applySelect(
          render.tokens,
          select.id,
          select.selectedText,
          select.multi,
          {
            file: this.filePath,
            diskHash: render.source.diskHash,
            stale: this.session.stale || this.document.isDirty,
            mode: this.mode,
          },
        );
        this.publishSelection(record);
      }
    }, null, this.disposables);

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
      const staleRecord = this.host.selection.markStale(this.filePath);
      if (staleRecord && selectionBelongsToPreview(staleRecord, this.filePath)) {
        this.publishSelection(staleRecord);
      }
      // DL132 P2: update the stale banner without rebuilding the whole webview.
      if (this.webviewReady) {
        void this.panel.webview.postMessage({ type: "stale" });
      } else {
        this.paint();
      }
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
    host: LiveSelectionHost,
    onChangeFocus?: (entry: LiveChangeEntry | undefined) => void,
  ): void {
    const existing = LivePreviewPanel.find(document.uri.fsPath);
    if (existing) {
      existing.panel.reveal(existing.panel.viewColumn);
      existing.document = document;
      roster.activatePreview(existing.filePath);
      existing.syncOutline();
      void existing.refresh();
      return;
    }
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Beside;
    const roots = new Map<string, vscode.Uri>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      roots.set(folder.uri.toString(), folder.uri);
      addLqCacheRoot(roots, folder.uri.fsPath);
    }
    const docDir = dirname(document.uri.fsPath);
    roots.set(document.uri.toString(), vscode.Uri.file(docDir));
    addLqCacheRoot(roots, docDir);
    let walk = docDir;
    for (let i = 0; i < 8; i++) {
      const parent = dirname(walk);
      if (parent === walk) break;
      walk = parent;
      addLqCacheRoot(roots, walk);
    }
    addLqCacheRoot(roots, homedir());
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
    new LivePreviewPanel(panel, document, outlineTree, host, onChangeFocus);
  }

  static find(path: string): LivePreviewPanel | undefined {
    const key = normalizeFsPath(path);
    const direct = LivePreviewPanel.byPath.get(key);
    if (direct) return direct;
    for (const [p, panel] of LivePreviewPanel.byPath) {
      if (sameFsPath(p, path)) return panel;
    }
    return undefined;
  }

  /** Scroll the preview for the file the outline is showing (focus unchanged). */
  static scrollToId(id: string, filePath: string | undefined): void {
    if (!filePath) return;
    LivePreviewPanel.find(filePath)?.postScrollToId(id);
  }

  /** Switch the focused panel's view mode without re-running lq (DL133). */
  static setMode(mode: ChangeViewMode): void {
    const target = roster.modeTarget();
    if (!target) return;
    LivePreviewPanel.find(target)?.setMode(mode);
  }

  /**
   * Scroll a visible .lyx editor to `line` without focusing it.
   * Never calls showTextDocument / never sets selection (both steal focus).
   */
  static revealSourceLine(line: number | undefined, filePath: string | undefined): void {
    if (!filePath || typeof line !== "number" || !Number.isFinite(line)) return;
    const visible = vscode.window.visibleTextEditors.find((ed) =>
      sameFsPath(ed.document.uri.fsPath, filePath)
    );
    if (!visible) return;
    const doc = visible.document;
    const safe = Math.max(0, Math.min(Math.floor(line), Math.max(0, doc.lineCount - 1)));
    const range = doc.lineAt(safe).range;
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
    changes?: LiveChangeEntry[],
  ): void {
    const lines = this.document.getText().split(/\r?\n/);
    const withLines = attachApproxLines(entries, lines);
    const rawNav = navigate ?? this.session.lastValid?.navigate;
    const nav = rawNav
      ? attachNavigateLines(dedupeNavigateLabels(rawNav), lines)
      : undefined;
    const cachedChanges = changes ?? this.session.lastValid?.changes;
    rememberOutline(this.filePath, entries, nav, cachedChanges);
    if (roster.showsOutline(this.filePath)) {
      this.outlineTree.refresh(this.filePath, withLines, nav, cachedChanges);
    }
  }

  /** Push this file’s outline into the tree (this panel is the outline target). */
  syncOutline(): void {
    const render = this.session.lastValid;
    if (render) {
      this.publishOutline(render.outline, render.navigate, render.changes);
      return;
    }
    this.publishOutline(scanLyxHeadingLines(this.document.getText().split(/\r?\n/)), undefined);
  }

  private async refresh(): Promise<void> {
    const generation = this.session.nextGeneration();
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    this.pending = true;
    this.paint();
    const timeoutMs = vscode.workspace.getConfiguration("lyx-preview", this.document.uri).get<number>("timeoutMs") ?? 30000;
    try {
      await ensureCompanionLq(this.document.uri);
      const lqPath = discoverLqBinary(this.document.uri);
      const render = await runLivePreview(lqPath, this.filePath, timeoutMs, abort.signal);
      if (abort.signal.aborted || generation !== this.session.generation) return;
      if (!this.session.applySuccess(generation, render)) return;
      // A successful render reflects the saved file; keep the banner when the
      // editor buffer still differs (edits during the render) — DL132 P2.
      this.session.stale = this.document.isDirty;
      this.publishOutline(render.outline, render.navigate, render.changes);
      const rec = this.host.selection.get();
      if (!rec || selectionBelongsToPreview(rec, this.filePath)) {
        this.publishSelection(
          rec
            ? this.host.selection.rematch(
              render.tokens,
              this.filePath,
              render.source.diskHash,
              this.session.stale,
            )
            : undefined,
        );
      }
      this.pending = false;
      this.paint();
    } catch (error) {
      if (abort.signal.aborted || generation !== this.session.generation) return;
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

  private publishSelection(record: LiveSelectionRecord | undefined): void {
    this.host.onSelectionChange(record);
    this.host.persistSelection(record, this.filePath);
  }

  private paint(error?: string): void {
    this.webviewReady = false;
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
      mode: this.mode,
      error,
      render,
      imgCsp: `${this.panel.webview.cspSource} data:`,
      scriptNonce: nonce,
      scriptCsp: `'nonce-${nonce}'`,
    }).replace("<head>", `<head>\n<!-- lyx-live ${bust} -->`);
  }

  private setMode(mode: ChangeViewMode): void {
    this.mode = mode;
    if (this.webviewReady) {
      void this.panel.webview.postMessage({ type: "setMode", mode });
    } else {
      // Panel is still pending/repainting — the next paint bakes this mode.
      this.paint();
    }
  }

  private dispose(): void {
    if (this.diskTimer) clearTimeout(this.diskTimer);
    this.abort?.abort();
    this.abort = undefined;
    for (const [p, panel] of [...LivePreviewPanel.byPath]) {
      if (panel === this || sameFsPath(p, this.filePath)) LivePreviewPanel.byPath.delete(p);
    }
    const ed = vscode.window.activeTextEditor;
    const activeLyx = ed?.document.fileName.toLowerCase().endsWith(".lyx")
      ? ed.document.uri.fsPath
      : undefined;
    const next = roster.close(this.filePath, activeLyx);
    forgetOutline(this.filePath);
    const rec = this.host.selection.get();
    if (!rec || selectionBelongsToPreview(rec, this.filePath)) {
      this.host.selection.clear();
      this.host.persistSelection(undefined, this.filePath);
      this.host.onSelectionChange(undefined);
    }
    this.onChangeFocus?.(undefined);
    setLiveOpenContext();
    if (next) {
      const other = LivePreviewPanel.find(next.path);
      if (other) other.syncOutline();
      else refreshOutlineForPath(this.outlineTree, next.path);
    } else {
      this.outlineTree.clear();
    }
    for (const d of this.disposables) d.dispose();
  }
}

function addLqCacheRoot(roots: Map<string, vscode.Uri>, dir: string): void {
  const lq = join(dir, ".lq");
  roots.set(lq, vscode.Uri.file(lq));
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
  return `LyX Preview: ${name}`;
}

function refreshOutlineForPath(
  outlineTree: LyxOutlineTreeProvider,
  filePath: string,
  doc?: vscode.TextDocument,
): void {
  const document = doc ?? vscode.workspace.textDocuments.find((d) =>
    sameFsPath(d.uri.fsPath, filePath)
  );
  if (document && document.fileName.toLowerCase().endsWith(".lyx")) {
    const lines = document.getText().split(/\r?\n/);
    const live = getCachedOutline(document.uri.fsPath);
    const outline = live && live.length > 0
      ? attachApproxLines(live, lines)
      : scanLyxHeadingLines(lines);
    const cachedNav = getCachedNavigate(document.uri.fsPath);
    const navigate = cachedNav
      ? attachNavigateLines(dedupeNavigateLabels(cachedNav), lines)
      : undefined;
    outlineTree.refresh(
      document.uri.fsPath,
      outline,
      navigate,
      getCachedChanges(document.uri.fsPath),
    );
    return;
  }
  const live = getCachedOutline(filePath);
  if (live && live.length > 0) {
    outlineTree.refresh(
      filePath,
      live,
      getCachedNavigate(filePath),
      getCachedChanges(filePath),
    );
    return;
  }
  outlineTree.clear();
}

export function activate(context: vscode.ExtensionContext): void {
  const outlineTree = new LyxOutlineTreeProvider();
  const treeView = vscode.window.createTreeView("lyxPreview.outline", {
    treeDataProvider: outlineTree,
    showCollapseAll: true,
  });
  const changeStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  const selectStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
  const selection = new LiveSelectionStore();
  const persister = new LiveSelectionPersister();
  const persistSelection = (
    record: LiveSelectionRecord | undefined,
    previewFile: string,
  ): void => {
    persister.persist(resolveLiveSelectionPath(previewFile), record);
  };
  const onSelectionChange = (record: LiveSelectionRecord | undefined): void => {
    if (!record) {
      selectStatus.hide();
      return;
    }
    selectStatus.text = `Selection: ${compactSelector(record)}`;
    selectStatus.tooltip = record.selector;
    selectStatus.show();
  };
  const host: LiveSelectionHost = { selection, persistSelection, onSelectionChange };
  const onLiveChangeFocus = (entry: LiveChangeEntry | undefined): void => {
    if (!entry) {
      changeStatus.hide();
      return;
    }
    const time = formatChangeTime(entry.ts);
    changeStatus.text = `Changed by ${entry.author}${time ? ` on ${time}` : ""}`;
    changeStatus.show();
  };

  /** Prefer Live outline/navigate ids (match preview HTML); fall back to buffer scan. */
  const refreshTreeForDoc = (doc: vscode.TextDocument | undefined) => {
    if (!doc || !doc.fileName.toLowerCase().endsWith(".lyx")) return;
    refreshOutlineForPath(outlineTree, doc.uri.fsPath, doc);
  };

  context.subscriptions.push(
    treeView,
    changeStatus,
    selectStatus,
    vscode.lm.registerTool(LM_TOOL_NAME, {
      invoke: () =>
        new vscode.LanguageModelToolResult([
          new vscode.LanguageModelTextPart(invokeLiveSelection(selection.get())),
        ]),
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("lyx-preview.lqPath")) {
        void ensureCompanionLq();
      }
    }),
    vscode.commands.registerCommand("lyx-preview.open", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || !editor.document.fileName.toLowerCase().endsWith(".lyx")) {
        void vscode.window.showWarningMessage("Open a .lyx document before opening LyX Preview.");
        return;
      }
      LivePreviewPanel.createOrShow(editor.document, outlineTree, host, onLiveChangeFocus);
    }),
    vscode.commands.registerCommand("lyx-preview.viewOriginal", () => {
      LivePreviewPanel.setMode("original");
    }),
    vscode.commands.registerCommand("lyx-preview.viewTracked", () => {
      LivePreviewPanel.setMode("tracked");
    }),
    vscode.commands.registerCommand("lyx-preview.viewClean", () => {
      LivePreviewPanel.setMode("clean");
    }),
    vscode.commands.registerCommand("lyx-preview.changeView", async () => {
      // J-E fallback: the submenu icon does not render in this VS Code
      // build's editor/title, so the Live panel title bar carries a plain
      // command button (icon = lyx-l-yellow.svg) that opens this quick pick.
      const picked = await vscode.window.showQuickPick(
        [
          { label: "Original", description: "Show the document before the changes", mode: "original" },
          { label: "Tracked", description: "Show insertions and deletions with markup (default)", mode: "tracked" },
          { label: "Clean", description: "Show the document after accepting all changes", mode: "clean" },
        ] as (vscode.QuickPickItem & { mode: ChangeViewMode })[],
        { placeHolder: "Tracked-change view" },
      );
      if (picked) LivePreviewPanel.setMode(picked.mode);
    }),
    vscode.commands.registerCommand(
      "lyx-preview.revealOutline",
      async (id: string, line?: number) => {
        roster.beginOutlineClick();
        try {
          const target = roster.scrollTarget();
          LivePreviewPanel.scrollToId(id, target);
          LivePreviewPanel.revealSourceLine(line, target);
          // TreeItem commands can still move focus; put it back on LyX Outline.
          await vscode.commands.executeCommand("lyxPreview.outline.focus");
        } finally {
          setTimeout(() => roster.endOutlineClick(), 0);
        }
      },
    ),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (!ed || !ed.document.fileName.toLowerCase().endsWith(".lyx")) return;
      if (!roster.activateEditor(ed.document.uri.fsPath)) return;
      refreshTreeForDoc(ed.document);
    }),
  );

  refreshTreeForDoc(vscode.window.activeTextEditor?.document);
  void ensureCompanionLq();
}

export function deactivate(): void {
  // Webview panels dispose through VS Code.
}
