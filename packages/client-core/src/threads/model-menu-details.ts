/**
 * Builds the detail the model menu shows beside a row's name, after " · ".
 * Both apps draw it, each in its own way, so the rule for what it says lives
 * here once.
 */
import type { ModelMenuProviderAccountRow, ModelMenuRow } from "./model-menu";

/**
 * Returns the detail beside a model's name: "default" for the account's
 * default model, or `null`. The current model has no detail, because its
 * check mark already says it is the one in use.
 */
export const describeModelRow = (row: ModelMenuRow): string | null =>
  row.isDefault && !row.current ? "default" : null;

/**
 * Returns the detail beside an account's name: who is signed in and on what
 * plan, joined with " · ", such as "work@example.com · Claude Pro". Returns
 * `null` when the account knows neither.
 */
export const describeProviderAccountRow = (account: ModelMenuProviderAccountRow): string | null => {
  const known = [account.identity, account.planLabel].filter((each) => each !== null);
  return known.length === 0 ? null : known.join(" · ");
};
