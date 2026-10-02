import { assert, describe, it } from "vitest";
import { isClonableRemote, parseRepositoryName } from "./remote";

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

describe("parseRepositoryName", () => {
  it("reads owner/repo from both accepted forms, as written", () => {
    assert.strictEqual(parseRepositoryName("git@github.com:rogier/webshop.git"), "rogier/webshop");
    assert.strictEqual(parseRepositoryName("https://github.com/rogier/webshop"), "rogier/webshop");
    assert.strictEqual(
      parseRepositoryName(" https://github.com/Rogier/WebShop.git/ "),
      "Rogier/WebShop",
    );
    assert.strictEqual(
      parseRepositoryName("https://git.example.com:8443/acme/webshop"),
      "acme/webshop",
    );
  });

  it("keeps every segment of a nested path", () => {
    assert.strictEqual(
      parseRepositoryName("git@gitlab.com:acme/platform/webshop.git"),
      "acme/platform/webshop",
    );
  });

  it("returns null for a remote it would not clone, or one with no owner", () => {
    assert.isNull(parseRepositoryName("/Users/rogier/webshop"));
    assert.isNull(parseRepositoryName("ssh://git@github.com/rogier/webshop"));
    assert.isNull(parseRepositoryName("https://github.com/webshop"));
    assert.isNull(parseRepositoryName("https://github.com"));
    assert.isNull(parseRepositoryName(""));
  });
});
