import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeFsPath, sameFsPath } from "./fsPath";

describe("fsPath", () => {
  it("normalizeFsPath unifies backslashes", () => {
    assert.equal(normalizeFsPath("C:\\Docs\\A.lyx"), "C:/Docs/A.lyx");
    assert.equal(normalizeFsPath("/tmp/a.lyx"), "/tmp/a.lyx");
  });

  it("sameFsPath folds case only on Windows", () => {
    if (process.platform === "win32") {
      assert.equal(sameFsPath("C:/Docs/A.LYX", "c:/docs/a.lyx"), true);
    } else {
      assert.equal(sameFsPath("/tmp/A.lyx", "/tmp/a.lyx"), false);
      assert.equal(sameFsPath("/tmp/A.lyx", "/tmp/A.lyx"), true);
    }
  });
});
