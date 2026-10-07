/** The numeric choices of a select in Settings > Assistants. */

/**
 * Returns `choices` with `stored` added when it is missing, sorted ascending.
 * A select whose value matches none of its options shows its first option
 * instead, so a value set outside the app, such as from the CLI, must be
 * one of the options for the select to show it.
 */
export const addStoredChoice = (
  choices: ReadonlyArray<number>,
  stored: number,
): ReadonlyArray<number> =>
  choices.includes(stored) ? choices : [...choices, stored].sort((a, b) => a - b);
