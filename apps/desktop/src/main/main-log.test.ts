import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { locateMainLog, makeMainLogLayer, openMainLog } from "./main-log";

let userDataDir: string;

beforeEach(() => {
  userDataDir = mkdtempSync(path.join(tmpdir(), "hercule-main-log-"));
});

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true });
});

describe("openMainLog", () => {
  it("creates the logs folder and a file only this user can read", () => {
    const file = locateMainLog(userDataDir);
    openMainLog(file, 1000)("first line");
    expect(readFileSync(file, "utf8")).toBe("first line\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it("appends to the file an earlier launch wrote", () => {
    const file = locateMainLog(userDataDir);
    openMainLog(file, 1000)("from the last launch");
    openMainLog(file, 1000)("from this launch");
    expect(readFileSync(file, "utf8")).toBe("from the last launch\nfrom this launch\n");
  });

  it("moves a full file aside and keeps only one old file", () => {
    const file = locateMainLog(userDataDir);
    const append = openMainLog(file, 10);
    append("aaaaaa");
    append("bbbbbb");
    append("cccccc");
    expect(readFileSync(file, "utf8")).toBe("cccccc\n");
    expect(readFileSync(`${file}.1`, "utf8")).toBe("bbbbbb\n");
  });

  it("writes a line longer than the limit into a new file of its own", () => {
    const file = locateMainLog(userDataDir);
    const append = openMainLog(file, 10);
    append("a line far past the limit");
    expect(readFileSync(file, "utf8")).toBe("a line far past the limit\n");
  });
});

describe("makeMainLogLayer", () => {
  it("writes what main logs to the file as logfmt", async () => {
    const file = locateMainLog(userDataDir);
    await Effect.runPromise(
      Effect.logWarning("The window's page stopped responding").pipe(
        Effect.provide(makeMainLogLayer(file)),
      ),
    );
    expect(readFileSync(file, "utf8")).toMatch(
      /level=WARN .*message="The window's page stopped responding"\n$/,
    );
  });
});
