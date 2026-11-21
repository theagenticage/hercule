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

describe("a flag that takes named values", () => {
  it("shows the <field>=<value> form and says the flag repeats", () => {
    const flags = readSection(buildCommandHelp(readCommand("ignoreRule.create")), "flags:");
    expect(flags[0]).toMatch(/^\s+--match <field>=<value>\s+required; repeatable$/);
  });
});

describe("a repeated positional and a list with one fixed order", () => {
  it("marks a positional that takes several words with ...", () => {
    const lines = buildCommandHelp(readCommand("signal.markDone"));
    expect(lines.some((line) => line.includes("signal done <signal-id>..."))).toBe(true);
  });

  it("offers no --sort on a paged list with one fixed order", () => {
    const lines = buildCommandHelp(readCommand("signal.query"));
    expect(lines.some((line) => line.includes("--limit"))).toBe(true);
    expect(lines.some((line) => line.includes("--sort"))).toBe(false);
  });
});

describe("an example", () => {
  // A shell expands a leading `~` only when it is not quoted.
  it("leaves a path under the home folder unquoted", () => {
    const lines = buildCommandHelp(readCommand("skill.import"));
    expect(lines).toContain("  hercule skill import ~/.agents/skills");
  });

  it("reads a secret from a file, never from an echo that the shell keeps in its history", () => {
    const lines = buildCommandHelp(readCommand("mcpServer.setToken"));
    expect(lines).toContain("  hercule mcp-server set-token 1f3a9c2e < token.txt");
    expect(lines.some((line) => line.includes("echo"))).toBe(false);
  });
});

describe("a command whose field of several shapes is filled from flags", () => {
  const command = readCommand("mcpServer.create");

  it("lists the flags of each form under its lead line", () => {
    const lines = buildCommandHelp(command);
    expect(lines).toContain("usage: hercule mcp-server create [flags]");
    const flags = lines
      .slice(lines.indexOf("flags:"), lines.indexOf("stdin:"))
      .filter((line) => line.trimStart().startsWith("--") || line.endsWith(":"))
      .filter((line) => line !== "flags:");
    expect(flags.map((line) => line.trim().replace(/\s+/g, " "))).toEqual([
      "From a plugin's Connection:",
      "--plugin <text> required",
      "--connection <text> required",
      "--name <text> optional",
      "By its address:",
      "--url <text> required",
      "--name <text> optional",
      "--token-stdin optional; read from stdin",
    ]);
  });

  it("shows the examples of both forms as flags", () => {
    const examples = readSection(buildCommandHelp(command), "examples:");
    expect(examples).toContain(
      "  hercule mcp-server create --plugin sentry/sentry --connection 1f3a9c2e",
    );
    expect(examples).toContain("  hercule mcp-server create --url https://mcp.notion.com/mcp");
  });
});
