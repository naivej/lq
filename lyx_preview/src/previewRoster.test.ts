import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PreviewRoster } from "./previewRoster";

const A = "C:/docs/a.lyx";
const B = "C:/docs/b.lyx";

describe("preview roster", () => {
  it("keeps two files registered", () => {
    const roster = new PreviewRoster();
    roster.open(A);
    roster.open(B);
    assert.equal(roster.isOpen(A), true);
    assert.equal(roster.isOpen(B), true);
  });

  it("does not add a duplicate for a second open of the same path", () => {
    const roster = new PreviewRoster();
    assert.equal(roster.open(A), true);
    assert.equal(roster.open(A), false);
    assert.equal(roster.open("C:\\docs\\a.lyx"), false);
    assert.equal(roster.size, 1);
  });

  it("closing one leaves the other", () => {
    const roster = new PreviewRoster();
    roster.open(A);
    roster.open(B);
    roster.close(B);
    assert.equal(roster.isOpen(A), true);
    assert.equal(roster.isOpen(B), false);
  });
});

describe("preview outline focus", () => {
  it("activate preview A then B focuses B", () => {
    const roster = new PreviewRoster();
    roster.open(A);
    roster.open(B);
    roster.activatePreview(A);
    roster.activatePreview(B);
    assert.equal(roster.focusedPath(), B);
  });

  it("activate .lyx A focuses A", () => {
    const roster = new PreviewRoster();
    roster.open(B);
    roster.activatePreview(B);
    roster.activateEditor(A);
    assert.equal(roster.focusedPath(), A);
  });

  it("mark preview inactive (outline click) keeps focused B", () => {
    const roster = new PreviewRoster();
    roster.open(A);
    roster.open(B);
    roster.activatePreview(A);
    roster.activatePreview(B);
    roster.markPreviewInactive(B);
    assert.equal(roster.focusedPath(), B);
  });

  it("ignores .lyx activation during an outline click", () => {
    const roster = new PreviewRoster();
    roster.open(B);
    roster.activatePreview(B);
    roster.beginOutlineClick();
    roster.activateEditor(A);
    roster.endOutlineClick();
    assert.equal(roster.focusedPath(), B);
  });
});

describe("outline scroll and mode target", () => {
  it("with A and B open and outline on A, scroll target is A not B", () => {
    const roster = new PreviewRoster();
    roster.open(A);
    roster.open(B);
    roster.activatePreview(B);
    roster.activatePreview(A);
    assert.equal(roster.scrollTarget(), A);
  });

  it("mode command targets focused path", () => {
    const roster = new PreviewRoster();
    roster.open(A);
    roster.open(B);
    roster.activatePreview(A);
    roster.activatePreview(B);
    assert.equal(roster.modeTarget(), B);
  });
});

describe("close preview focus", () => {
  it("close focused B with A remaining focuses A", () => {
    const roster = new PreviewRoster();
    roster.open(A);
    roster.activatePreview(A);
    roster.open(B);
    roster.activatePreview(B);
    roster.close(B);
    assert.equal(roster.focusedPath(), A);
    assert.equal(roster.isOpen(A), true);
  });

  it("close last focuses empty", () => {
    const roster = new PreviewRoster();
    roster.open(A);
    roster.activatePreview(A);
    roster.close(A);
    assert.equal(roster.focusedPath(), undefined);
  });

  it("close last restores the active .lyx editor", () => {
    const roster = new PreviewRoster();
    roster.open(B);
    roster.activatePreview(B);
    roster.close(B, A);
    assert.equal(roster.focusedPath(), A);
    assert.equal(roster.isOpen(B), false);
  });

  it("closing a preview while that file’s editor is focused keeps the editor", () => {
    const roster = new PreviewRoster();
    roster.open(A);
    roster.open(B);
    roster.activatePreview(A);
    roster.activatePreview(B);
    roster.activateEditor(B);
    roster.close(B);
    assert.equal(roster.focusedPath(), B);
    assert.equal(roster.isOpen(A), true);
  });
});
