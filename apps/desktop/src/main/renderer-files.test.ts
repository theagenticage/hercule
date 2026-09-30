import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRendererFileTable, findRendererFile, type RendererFileTable } from "./renderer-files";

// A scratch folder laid out like the renderer's build, next to files a
// request must never reach: one outside the build, and links pointing out.
let scratch: string;
let build: string;
let table: RendererFileTable;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "hercule-desktop-renderer-files-"));
  build = join(scratch, "renderer");
  mkdirSync(join(build, "assets"), { recursive: true });
  writeFileSync(join(build, "index.html"), "<!doctype html>");
  writeFileSync(join(build, "theme-init.js"), "");
  writeFileSync(join(build, "assets", "index-D6RJyTLH.js"), "");
  writeFileSync(join(build, "assets", "index-DcKzHjTh.css"), "");
  writeFileSync(join(build, "assets", "bricolage-grotesque-latin-C5Lc8Qmc.woff2"), "");
  writeFileSync(join(build, "notes.txt"), "");
  mkdirSync(join(build, "folder.js"));
  writeFileSync(join(scratch, "secret.js"), "");
  mkdirSync(join(scratch, "elsewhere"));
  writeFileSync(join(scratch, "elsewhere", "app.js"), "");
  symlinkSync(join(scratch, "secret.js"), join(build, "link.js"));
  symlinkSync(join(scratch, "elsewhere"), join(build, "linked"));
  table = buildRendererFileTable(build);
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("buildRendererFileTable", () => {
  it("lists the build's files of the kinds it serves, and no link", () => {
    expect([...table.keys()].sort()).toEqual([
      "/assets/bricolage-grotesque-latin-C5Lc8Qmc.woff2",
      "/assets/index-D6RJyTLH.js",
      "/assets/index-DcKzHjTh.css",
      "/index.html",
      "/theme-init.js",
    ]);
  });
});

describe("findRendererFile", () => {
  it.each([
    ["app://hercule/", "index.html", "text/html; charset=utf-8"],
    ["app://hercule/index.html", "index.html", "text/html; charset=utf-8"],
    ["app://hercule/theme-init.js", "theme-init.js", "text/javascript; charset=utf-8"],
    [
      "app://hercule/assets/index-D6RJyTLH.js?import",
      "assets/index-D6RJyTLH.js",
      "text/javascript; charset=utf-8",
    ],
    [
      "app://hercule/assets/index-DcKzHjTh.css",
      "assets/index-DcKzHjTh.css",
      "text/css; charset=utf-8",
    ],
    [
      "app://hercule/assets/bricolage-grotesque-latin-C5Lc8Qmc.woff2",
      "assets/bricolage-grotesque-latin-C5Lc8Qmc.woff2",
      "font/woff2",
    ],
  ])("serves %s", (url, file, contentType) => {
    expect(findRendererFile(table, url)).toEqual({ path: join(build, file), contentType });
  });

  // Each of these paths is not in the table, so it is answered with 404
  // whatever the disk holds.
  it.each([
    ["another host", "app://elsewhere/index.html"],
    ["another scheme", "file:///etc/passwd"],
    ["a file that does not exist", "app://hercule/assets/missing.js"],
    ["a folder", "app://hercule/assets"],
    ["a folder with a file's name", "app://hercule/folder.js"],
    ["a trailing slash", "app://hercule/assets/"],
    ["a kind of file the build does not produce", "app://hercule/notes.txt"],
    ["a path through a file", "app://hercule/index.html/x.js"],
    [
      "dot segments, which the URL resolves inside the origin",
      "app://hercule/assets/../../secret.js",
    ],
    ["encoded dot segments", "app://hercule/%2e%2e/secret.js"],
    ["an encoded slash", "app://hercule/..%2fsecret.js"],
    ["an encoded dot and slash", "app://hercule/assets/%2e%2e%2f%2e%2e%2fsecret.js"],
    ["a doubly encoded dot", "app://hercule/%252e%252e/secret.js"],
    ["a backslash", "app://hercule/..\\secret.js"],
    ["an encoded backslash", "app://hercule/..%5csecret.js"],
    ["a null byte", "app://hercule/index.html%00.js"],
    ["an absolute path in the path", "app://hercule//etc/passwd.js"],
    ["a symbolic link to a file outside", "app://hercule/link.js"],
    ["a file under a symbolic link to a folder outside", "app://hercule/linked/app.js"],
  ])("answers 404 for %s", (_case, url) => {
    expect(findRendererFile(table, url)).toBeNull();
  });
});
