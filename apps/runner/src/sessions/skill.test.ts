/**
 * Checks the skill text an agent reads inside a session against the CLI's
 * command tree.
 *
 * The skill is a skeleton: it names the three help forms and sends the agent
 * to `--help` for everything else, so the agent learns the CLI one level at a
 * time. So the test does not only check that every command in the text exists.
 * It checks a stricter rule: the only commands in the text are help commands.
 * A worked example command would be a second copy of the contract, and because
 * the skill text is written by hand, nothing else would catch it going stale.
 * Spec 11 section 6.3 owns the rule.
 */
import { describe, expect, it } from "vitest";
import { CLI } from "@hercule/contract";
import { HERCULE_SKILL } from "./skill";

/** Every visible command, as the words that follow `hercule`. */
const COMMANDS: ReadonlyArray<ReadonlyArray<string>> = Object.values(CLI).flatMap((row) =>
  "command" in row ? [row.command.split(" ")] : [],
);

/** Checks that a word is a noun this build has, or the `<noun>` placeholder. */
const isNoun = (word: string): boolean =>
  word === "<noun>" || COMMANDS.some((command) => command[0] === word);

/** Checks that a word is a verb of `noun`, or the `<verb>` placeholder. Under `<noun>`, any noun's verb counts. */
const isVerb = (noun: string, word: string): boolean =>
  word === "<verb>" ||
  COMMANDS.some((command) => (noun === "<noun>" || command[0] === noun) && command[1] === word);

/**
 * Checks that the words after `hercule` are one of the three help forms the
 * skill may name: the root help, a noun's help, and a verb's help. Anything
 * else, such as a bare `hercule` or a worked command, belongs in the CLI's own
 * help.
 */
const isHelpForm = (rest: string): boolean => {
  const words = rest.split(" ").filter((word) => word !== "");
  if (words.at(-1) !== "--help") return false;
  const path = words.slice(0, -1);
  if (path.length === 0) return true;
  if (!isNoun(path[0]!)) return false;
  if (path.length === 1) return true;
  return path.length === 2 && isVerb(path[0]!, path[1]!);
};

describe("the hercule skill", () => {
  it("contains only the three help forms, with nouns and verbs this build has", () => {
    const text: string = HERCULE_SKILL;
    const spelled: ReadonlyArray<string> = [...text.matchAll(/`(hercule(?:\s[^`]*)?)`/g)].map(
      (found) => found[1]!.trim().replace(/\s+/g, " "),
    );

    // A skill with no commands at all would pass the check below while
    // teaching an agent nothing, because the help forms are all it contains.
    expect(spelled.length).toBeGreaterThan(0);

    const wrong = spelled.filter((command) => !isHelpForm(command.slice("hercule".length).trim()));
    expect(wrong, `the skill contains a command that is not one of the three help forms`).toEqual(
      [],
    );
  });
});
