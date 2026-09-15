/**
 * The skill text an agent reads inside a session, checked against the command
 * tree it points at.
 *
 * Progressive disclosure (spec 11 section 6.3): the skill is a skeleton that
 * names the three help forms and sends the agent to `--help` for everything
 * else. A command it spells that this build does not have teaches an agent a
 * command that fails, and nothing else would catch it - the skill text is not
 * derived from the contract, it is written by hand.
 */
import { describe, expect, it } from "vitest";
import { CLI } from "@hydra/contract";
import { HYDRA_SKILL } from "./skill";

/** The three forms spec 11 section 6.3 lets the skill name, as it spells them. */
const HELP_FORMS = ["--help", "<noun> --help", "<noun> <verb> --help"];

/** Every visible command, as the words that follow `hydra`. */
const COMMANDS: ReadonlyArray<ReadonlyArray<string>> = Object.values(CLI).flatMap((row) =>
  "command" in row ? [row.command.split(" ")] : [],
);

/** A help form spelled with real nouns: `hydra task --help`. */
const isHelpOf = (words: ReadonlyArray<string>): boolean =>
  words.length <= 2 &&
  COMMANDS.some((command) => words.every((word, index) => command[index] === word));

describe("the hydra skill", () => {
  it("names no command this build does not have", () => {
    const text: string = HYDRA_SKILL;
    const spelled: ReadonlyArray<string> = [...text.matchAll(/`(hydra(?:\s[^`]*)?)`/g)].map(
      (found) => found[1]!.trim().replace(/\s+/g, " "),
    );

    // A skill that names nothing at all would pass every check below while
    // teaching an agent nothing: the help forms are the whole of its content.
    expect(spelled.length).toBeGreaterThan(0);
    const unknown = spelled.filter((command) => {
      const rest = command.slice("hydra".length).trim();
      if (HELP_FORMS.includes(rest)) return false;
      const words = rest === "" ? [] : rest.split(" ");
      const named = words.filter((word) => !word.startsWith("-") && !word.startsWith("<"));
      if (words[words.length - 1] === "--help") return !isHelpOf(named);
      return !COMMANDS.some(
        (built) => built.length === named.length && built.every((word, i) => word === named[i]),
      );
    });
    expect(unknown, `the skill spells commands this build has no row for`).toEqual([]);
  });
});
