import { assert, describe, it } from "vitest";
import { isClonableRemote } from "./remote";

describe("isClonableRemote", () => {
  it("accepts an https URL and git's scp-like form", () => {
    assert.isTrue(isClonableRemote("https://github.com/acme/webshop"));
    assert.isTrue(isClonableRemote("https://github.com/acme/webshop.git"));
    assert.isTrue(isClonableRemote("HTTPS://github.com/acme/webshop"));
    assert.isTrue(isClonableRemote("git@github.com:acme/webshop.git"));
    assert.isTrue(isClonableRemote("  git@github.com:acme/webshop  "));
  });

  it("rejects other schemes and local paths", () => {
    assert.isFalse(isClonableRemote("http://github.com/acme/webshop"));
    assert.isFalse(isClonableRemote("ssh://git@github.com/acme/webshop"));
    assert.isFalse(isClonableRemote("file:///Users/you/code/webshop"));
    assert.isFalse(isClonableRemote("/Users/you/code/webshop"));
    assert.isFalse(isClonableRemote("acme/webshop"));
  });

  it("rejects a value git would read as an option, and an empty value", () => {
    assert.isFalse(isClonableRemote("--upload-pack=rm -rf /"));
    assert.isFalse(isClonableRemote("-https://github.com/acme/webshop"));
    assert.isFalse(isClonableRemote(""));
    assert.isFalse(isClonableRemote("   "));
  });
});
