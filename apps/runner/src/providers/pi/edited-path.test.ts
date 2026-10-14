import { describe, expect, it } from "vitest";
import { resolvePiPath, readPiHome } from "./edited-path";

const HOME = "/home/ada";

describe("resolvePiPath", () => {
  it("keeps an absolute path and a relative path as written", () => {
    expect(resolvePiPath("/work/a.ts", HOME)).toBe("/work/a.ts");
    expect(resolvePiPath("src/a.ts", HOME)).toBe("src/a.ts");
  });

  it("removes one leading @ and no more", () => {
    expect(resolvePiPath("@src/a.ts", HOME)).toBe("src/a.ts");
    expect(resolvePiPath("@@a.ts", HOME)).toBe("@a.ts");
    expect(resolvePiPath("src/@a.ts", HOME)).toBe("src/@a.ts");
  });

  it("starts ~ and ~/ at the home directory, but not ~user", () => {
    expect(resolvePiPath("~", HOME)).toBe(HOME);
    expect(resolvePiPath("~/x/a.ts", HOME)).toBe("/home/ada/x/a.ts");
    expect(resolvePiPath("~bob/a.ts", HOME)).toBe("~bob/a.ts");
  });

  it("expands ~ after the @ is removed", () => {
    expect(resolvePiPath("@~/a.ts", HOME)).toBe("/home/ada/a.ts");
  });

  it("replaces Unicode spaces with ordinary spaces", () => {
    expect(resolvePiPath("my\u00A0notes\u202Ffile\u3000.md", HOME)).toBe("my notes file .md");
  });

  it("converts a file URL to a path and keeps a broken one", () => {
    expect(resolvePiPath("file:///work/a%20b.ts", HOME)).toBe("/work/a b.ts");
    expect(resolvePiPath("file://remote/a.ts", HOME)).toBe("file://remote/a.ts");
  });
});

describe("readPiHome", () => {
  it("uses HOME of the environment pi runs in, else the user's home", () => {
    expect(readPiHome({ HOME: "/srv/pi" })).toBe("/srv/pi");
    expect(readPiHome({ HOME: "" })).not.toBe("");
    expect(readPiHome({})).not.toBe("");
  });
});
