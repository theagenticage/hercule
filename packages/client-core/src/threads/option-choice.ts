import type { ModelOptionRow } from "./options-menu";

/**
 * Returns the value to pick when the user chooses `choice` in the options
 * menu's `row`: `true` or `false` for a boolean option, whose menu offers
 * "off" and "on", and `choice` itself for any other option.
 *
 * The provider expects a boolean option's value as a boolean, so "on" is
 * never sent as text.
 */
export const parseOptionChoice = (row: ModelOptionRow, choice: string): string | boolean =>
  row.boolean ? choice === "on" : choice;
