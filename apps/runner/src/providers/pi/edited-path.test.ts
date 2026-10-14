import { describe, expect, it } from "vitest";
import { readPiEditedPath, readPiHome } from "./edited-path";

const HOME = "/home/ada";

describe("readPiEditedPath", () => {
  it("keeps an absolute path and a relative path as written", () => {
    expect(readPiEditedPath("/work/a.ts", HOME)).toBe("/work/a.ts");
    expect(readPiEditedPath("src/a.ts", HOME)).toBe("src/a.ts");
  });

  it("removes one leading @ and no more", () => {
    expect(readPiEditedPath("@src/a.ts", HOME)).toBe("src/a.ts");
    expect(readPiEditedPath("@@a.ts", HOME)).toBe("@a.ts");
    expect(readPiEditedPath("src/@a.ts", HOME)).toBe("src/@a.ts");
  });

  it("starts ~ and ~/ at the home directory, but not ~user", () => {
    expect(readPiEditedPath("~", HOME)).toBe(HOME);
    expect(readPiEditedPath("~/x/a.ts", HOME)).toBe("/home/ada/x/a.ts");
    expect(readPiEditedPath("~bob/a.ts", HOME)).toBe("~bob/a.ts");
  });

  it("expands ~ after the @ is removed", () => {
    expect(readPiEditedPath("@~/a.ts", HOME)).toBe("/home/ada/a.ts");
  });

  it("replaces Unicode spaces with ordinary spaces", () => {
    expect(readPiEditedPath("my\u00A0notes\u202Ffile\u3000.md", HOME)).toBe("my notes file .md");
  });

  it("converts a file URL to a path and keeps a broken one", () => {
    expect(readPiEditedPath("file:///work/a%20b.ts", HOME)).toBe("/work/a b.ts");
    expect(readPiEditedPath("file://remote/a.ts", HOME)).toBe("file://remote/a.ts");
  });
});

describe("readPiHome", () => {
  it("uses HOME of the environment pi runs in, else the user's home", () => {
    expect(readPiHome({ HOME: "/srv/pi" })).toBe("/srv/pi");
    expect(readPiHome({ HOME: "" })).not.toBe("");
    expect(readPiHome({})).not.toBe("");
  });
});
