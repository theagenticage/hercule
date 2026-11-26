import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect, Logger } from "effect";
import { cleanupHomes, createScratchHome } from "./testing";
import { readUserInstructions } from "./user-instructions";

afterAll(cleanupHomes);

/** Runs `readUserInstructions` and returns its result with every warning it logged. */
const readCapturingWarnings = (paths: ReadonlyArray<string>) => {
  const warnings: Array<string> = [];
  const collecting = Logger.make<unknown, void>(({ logLevel, message }) => {
    if (logLevel === "Warn") warnings.push(String(message));
  });
  const text = Effect.runSync(
    Effect.provide(readUserInstructions(paths), Logger.layer([collecting])),
  );
  return { text, warnings };
};

describe("readUserInstructions", () => {
  const scratch = createScratchHome("instructions");
  const writeFile = (name: string, text: string): string => {
    const path = join(scratch, name);
    writeFileSync(path, text);
    return path;
  };

  it("returns the text of each file in the given order, joined by a blank line", () => {
    const first = writeFile("first.md", "Always answer in English.");
    const second = writeFile("second.md", "Keep commits small.\n");

    expect(readCapturingWarnings([second, first])).toEqual({
      text: "Keep commits small.\n\n\nAlways answer in English.",
      warnings: [],
    });
  });

  it("returns undefined when there are no files", () => {
    expect(readCapturingWarnings([])).toEqual({ text: undefined, warnings: [] });
  });

  it("leaves out a file with only white space", () => {
    const blank = writeFile("blank.md", "  \n");
    const real = writeFile("real.md", "Be terse.");

    expect(readCapturingWarnings([blank, real]).text).toBe("Be terse.");
    expect(readCapturingWarnings([blank]).text).toBeUndefined();
  });

  it.each([
    ["a file that does not exist", () => join(scratch, "missing.md"), "ENOENT"],
    [
      "a directory",
      () => {
        const path = join(scratch, "a-folder");
        mkdirSync(path);
        return path;
      },
      "it is not a regular file",
    ],
  ])(
    "skips %s, logs a warning with the path and the reason, and still reads the others",
    (_, makePath, reason) => {
      const path = makePath();
      const good = writeFile("good.md", "Be terse.");

      const { text, warnings } = readCapturingWarnings([path, good]);

      expect(text).toBe("Be terse.");
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(`Did not read ${path} into the Thread's instructions: `);
      expect(warnings[0]).toContain(reason);
    },
  );

  it("returns undefined when no file could be read", () => {
    const path = join(scratch, "gone.md");

    const { text, warnings } = readCapturingWarnings([path]);

    expect(text).toBeUndefined();
    expect(warnings).toHaveLength(1);
  });

  it("reads at most 64 KiB of a file and warns how much it left out", () => {
    const big = writeFile("big.md", `${"a".repeat(64 * 1024)}${"b".repeat(1000)}`);

    const { text, warnings } = readCapturingWarnings([big]);

    expect(text).toBe("a".repeat(64 * 1024));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`Cut ${big} `);
    expect(warnings[0]).toContain("left out the last 1000 of its 66536 bytes");
  });

  it("reads at most 256 KiB of all files, and leaves out the files after that with a warning", () => {
    const names = ["one", "two", "three", "four", "five"];
    const paths = names.map((name) => writeFile(`${name}.md`, `${name[0]}`.repeat(64 * 1024)));

    const { text, warnings } = readCapturingWarnings(paths);

    expect(text).toBe(
      paths
        .slice(0, 4)
        .map((_, index) => `${names[index]?.[0]}`.repeat(64 * 1024))
        .join("\n\n"),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`Left ${paths[4]} out of the Thread's instructions`);
  });

  it("does not wait on a named pipe, and skips it with a warning", () => {
    const pipe = join(scratch, "pipe.md");
    Bun.spawnSync(["mkfifo", pipe]);

    const { text, warnings } = readCapturingWarnings([pipe]);

    expect(text).toBeUndefined();
    expect(warnings[0]).toContain("it is not a regular file");
  });

  it("writes a control character of a path into a warning escaped", () => {
    const path = join(scratch, "forged\nWARN fake line.md");
    symlinkSync(path, path);

    const { warnings } = readCapturingWarnings([path]);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).not.toContain("\n");
    expect(warnings[0]).toContain("forged\\u{a}WARN fake line.md");
  });
});
