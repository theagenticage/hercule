/**
 * The skill text an agent reads inside a session, checked against the command
 * tree it points at.
 *
 * Progressive disclosure (spec 11 section 6.3): the skill is a skeleton that
 * names the three help forms and sends the agent to `--help` for everything
 * else. So the rule held here is not "every command it spells exists" but the
 * stricter one the spec asks for: the only invocations it spells are help.
 * A worked command would be a second copy of the contract to keep true, and
 * nothing else would catch it going stale - the skill text is written by hand.
 */
import { describe, expect, it } from "vitest";
import { CLI } from "@hydra/contract";
import { HYDRA_SKILL } from "./skill";

/** Every visible command, as the words that follow `hydra`. */
const COMMANDS: ReadonlyArray<ReadonlyArray<string>> = Object.values(CLI).flatMap((row) =>
  "command" in row ? [row.command.split(" ")] : [],
);

/** A noun the build has, or the placeholder the skill stands one in with. */
const isNoun = (word: string): boolean =>
  word === "<noun>" || COMMANDS.some((command) => command[0] === word);

/** A verb that noun has, or the placeholder; under `<noun>`, any noun's verb. */
const isVerb = (noun: string, word: string): boolean =>
  word === "<verb>" ||
  COMMANDS.some((command) => (noun === "<noun>" || command[0] === noun) && command[1] === word);

/**
 * The three forms spec 11 section 6.3 lets the skill name: the root help, a
 * noun's, and a verb's. Anything else - a bare `hydra`, or a worked command -
 * is content the CLI's own help owns.
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

describe("the hydra skill", () => {
  it("spells nothing but the three help forms, with nouns and verbs this build has", () => {
    const text: string = HYDRA_SKILL;
    const spelled: ReadonlyArray<string> = [...text.matchAll(/`(hydra(?:\s[^`]*)?)`/g)].map(
      (found) => found[1]!.trim().replace(/\s+/g, " "),
    );

    // A skill that names nothing at all would pass the check below while
    // teaching an agent nothing: the help forms are the whole of its content.
    expect(spelled.length).toBeGreaterThan(0);

    const wrong = spelled.filter((command) => !isHelpForm(command.slice("hydra".length).trim()));
    expect(wrong, `the skill spells something that is not one of the three help forms`).toEqual([]);
  });
});
