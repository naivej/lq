/** Open Live previews and which document LyX Outline is showing. */

import { normalizeFsPath, sameFsPath } from "./fsPath";

export type OutlineFocusKind = "preview" | "editor";

export interface OutlineFocus {
  path: string;
  kind: OutlineFocusKind;
}

/**
 * One preview per file, plus outline focus (last preview or `.lyx` you clicked).
 * Outline clicks do not count as switching away.
 */
export class PreviewRoster {
  /** Most recently used preview first. */
  private readonly mru: string[] = [];
  private focus: OutlineFocus | undefined;
  private outlineClick = false;

  get size(): number {
    return this.mru.length;
  }

  isOpen(path: string): boolean {
    return this.indexOf(path) >= 0;
  }

  /** Register a preview. Returns false when this file already has one. */
  open(path: string): boolean {
    const key = normalizeFsPath(path);
    if (this.indexOf(key) >= 0) return false;
    this.mru.push(key);
    return true;
  }

  /**
   * Drop a preview. If it was the outline’s document, focus the preview used
   * most recently before that, else `activeLyxEditor`, else nothing.
   */
  close(path: string, activeLyxEditor?: string): OutlineFocus | undefined {
    const idx = this.indexOf(path);
    if (idx >= 0) this.mru.splice(idx, 1);

    const closedWasFocusedPreview = this.focus?.kind === "preview" &&
      sameFsPath(this.focus.path, path);
    if (!closedWasFocusedPreview) return this.focus;

    if (this.mru.length > 0) {
      const next = this.mru[0];
      if (next !== undefined) this.focus = { path: next, kind: "preview" };
    } else if (activeLyxEditor) {
      this.focus = { path: normalizeFsPath(activeLyxEditor), kind: "editor" };
    } else {
      this.focus = undefined;
    }
    return this.focus;
  }

  activatePreview(path: string): void {
    const key = normalizeFsPath(path);
    this.touch(key);
    this.focus = { path: key, kind: "preview" };
  }

  /** Returns false when an outline click is in progress (do not steal focus). */
  activateEditor(path: string): boolean {
    if (this.outlineClick) return false;
    this.focus = { path: normalizeFsPath(path), kind: "editor" };
    return true;
  }

  /** Preview tab lost focus (outline click or another tab). Outline stays. */
  markPreviewInactive(_path: string): void {
    // Focus is sticky until a preview or `.lyx` editor is chosen on purpose.
  }

  beginOutlineClick(): void {
    this.outlineClick = true;
  }

  endOutlineClick(): void {
    this.outlineClick = false;
  }

  focusedPath(): string | undefined {
    return this.focus?.path;
  }

  showsOutline(path: string): boolean {
    return this.focus !== undefined && sameFsPath(this.focus.path, path);
  }

  /** File the outline is showing — heading clicks scroll this document. */
  scrollTarget(): string | undefined {
    return this.focus?.path;
  }

  /** Preview that tracked-change view buttons apply to, if that file is open. */
  modeTarget(): string | undefined {
    const path = this.focus?.path;
    if (!path || !this.isOpen(path)) return undefined;
    return path;
  }

  private indexOf(path: string): number {
    return this.mru.findIndex((p) => sameFsPath(p, path));
  }

  private touch(path: string): void {
    const idx = this.indexOf(path);
    if (idx < 0) return;
    const [entry] = this.mru.splice(idx, 1);
    if (entry !== undefined) this.mru.unshift(entry);
  }
}
