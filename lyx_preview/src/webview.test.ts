import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderWebviewHtml } from "./webview";

function render(mode?: "original" | "tracked" | "clean"): string {
  return renderWebviewHtml({
    title: "LyX Live: a.lyx",
    stale: false,
    pending: false,
    mode,
    render: {
      contract: "lyx-preview/live-1",
      projection: "live",
      html: "<article class=\"lyx-live\">x</article>",
      source: {
        path: "C:/tmp/a.lyx",
        hashAlgorithm: "sha256",
        hashInput: "raw-file-bytes",
        diskHash: "a".repeat(64),
        lineEnding: "lf",
        lineCount: 2,
        fresh: true,
      },
      capabilities: {
        review: false,
        mapping: false,
        outline: true,
        editing: false,
        sourceReveal: false,
      },
      diagnostics: [],
      outline: [],
      navigate: {
        figures: [],
        tables: [],
        equations: [],
        labels: [],
        listings: [],
        algorithms: [],
      },
      changes: [],
    },
    imgCsp: "'none'",
    scriptCsp: "'nonce-test123'",
    scriptNonce: "test123",
  });
}

describe("renderWebviewHtml change views", () => {
  it("bakes the default Tracked mode on body", () => {
    assert.match(render(), /<body data-mode="tracked">/);
  });

  it("bakes an explicit mode", () => {
    assert.match(render("clean"), /<body data-mode="clean">/);
    assert.match(render("original"), /<body data-mode="original">/);
  });

  it("keeps the CSP script nonce and has no remote content", () => {
    const html = render("tracked");
    assert.match(html, /script-src 'nonce-test123'/);
    assert.doesNotMatch(html, /https?:\/\//);
  });

  it("ships the setMode allowlist and changeFocus script", () => {
    const html = render("tracked");
    assert.match(html, /msg\.mode === "original" \|\| msg\.mode === "tracked" \|\| msg\.mode === "clean"/);
    assert.match(html, /vscode\.postMessage\(\{ type: "changeFocus"/);
    assert.match(html, /closest\("ins\.change-inserted, del\.change-deleted"\)/);
  });

  it("ships the three-view CSS", () => {
    const html = render("tracked");
    assert.match(html, /body\[data-mode="original"\] ins\.change-inserted/);
    assert.match(html, /body\[data-mode="clean"\] del\.change-deleted/);
    assert.match(html, /body\[data-mode="clean"\] div\.change-deleted/);
    assert.match(html, /ins\.change-author-0, del\.change-author-0/);
    assert.match(html, /ins\.change-author-1, del\.change-author-1/);
  });

  it("strikes deleted disclosures whose chip stops the parent line-through", () => {
    const html = render("tracked");
    assert.match(html, /del\.change-deleted details\.disclose > \*/);
    assert.match(html, /body\[data-mode="original"\] del\.change-deleted details\.disclose > \*/);
  });
});
