import { describe, expect, it } from "vitest";
import { buildCommandHelp, buildNounHelp, buildRootHelp } from "./help";
import type { OperationId } from "@hercule/contract";
import { COMMANDS, findCommandById, type Command } from "./tree";

/** The width help.ts wraps prose at. */
const HELP_WIDTH = 94;

/** The headers that end a command help's examples section. */
const SECTIONS_AFTER_EXAMPLES = new Set([
  "arguments:",
  "flags:",
  "stdin:",
  "paging:",
  "returns:",
  "errors:",
]);

/**
 * Returns a command's help without its examples. An example is a command line
 * to paste, so it is never wrapped and may hold anything a shell accepts.
 */
const readProse = (command: Command): ReadonlyArray<string> => {
  const lines = buildCommandHelp(command);
  const from = lines.indexOf("examples:");
  const to = lines.findIndex((line, index) => index > from && SECTIONS_AFTER_EXAMPLES.has(line));
  return [...lines.slice(0, from), ...(to === -1 ? [] : lines.slice(to))];
};

/** Returns the lines of one section of a command's help, without its header. */
const readSection = (lines: ReadonlyArray<string>, header: string): ReadonlyArray<string> => {
  const from = lines.indexOf(header);
  const to = lines.indexOf("", from);
  return lines.slice(from + 1, to === -1 ? lines.length : to);
};

const readCommand = (id: OperationId): Command => {
  const command = findCommandById(id);
  if (command === undefined) throw new Error(`no command for ${id}`);
  return command;
};

/** Every noun and nested noun, as the words after `hercule`. */
const NOUN_PREFIXES = [
  ...new Set(
    COMMANDS.flatMap((command) =>
      command.words.slice(0, -1).map((_, index) => command.words.slice(0, index + 1).join(" ")),
    ),
  ),
].map((prefix) => prefix.split(" "));

describe("wrapping", () => {
  it("keeps the root help and every noun's help within the width", () => {
    const pages = [buildRootHelp(), ...NOUN_PREFIXES.map((prefix) => buildNounHelp(prefix))];
    for (const line of pages.flat()) {
      expect(line.length, line).toBeLessThanOrEqual(HELP_WIDTH);
    }
  });

  // A command split across two lines cannot be copied whole.
  it("never splits a code span across two lines", () => {
    const pages = [
      buildRootHelp(),
      ...NOUN_PREFIXES.map((prefix) => buildNounHelp(prefix)),
      ...COMMANDS.map(readProse),
    ];
    for (const line of pages.flat()) {
      expect(line.split("`").length % 2, line).toBe(1);
    }
  });

  it("moves a word down rather than leave one alone on a paragraph's last line", () => {
    const flags = readSection(buildCommandHelp(readCommand("task.query")), "flags:");
    const sort = flags.findIndex((line) => line.trimStart().startsWith("--sort "));
    expect(flags[sort]).toMatch(/optional; repeatable; one of: updatedAt, createdAt,$/);
    expect(flags[sort + 1]!.trim()).toBe("priority, status");
  });
});

describe("the root help", () => {
  // A code at the end of one line and its meaning on the next is easy to misread.
  it("gives each exit code a line of its own", () => {
    const lines = buildRootHelp().map((line) => line.trim());
    expect(lines).toContain("exit    0 succeeded.");
    expect(lines.some((line) => line.startsWith("1 an error envelope came back"))).toBe(true);
    expect(lines).toContain("2 the command line was wrong, and nothing was sent.");
    expect(lines).toContain("3 no credential, or no controller.");
    expect(lines.some((line) => line.endsWith(" 3"))).toBe(false);
  });
});

describe("the validation error line", () => {
  const readValidation = (id: OperationId): string =>
    readSection(buildCommandHelp(readCommand(id)), "errors:")
      .find((line) => line.trimStart().startsWith("validation "))!
      .trim()
      .replace(/\s+/g, " ");

  // A read never writes, so saying nothing was written would suggest it might have.
  it("does not say nothing was written on a command that only reads", () => {
    expect(readValidation("task.query")).toBe("validation an argument does not fit its field");
  });

  it("says nothing was written on a command that writes", () => {
    expect(readValidation("task.create")).toContain("nothing was written");
  });
});
