/**
 * How the clients name a signal's kind, such as "Review requested" for
 * `github/review-requested`.
 */

/** The labels of the core's kinds. A plugin kind is labelled from its id instead. */
const CORE_KIND_LABELS: Readonly<Record<string, string>> = {
  proposal: "Proposal",
  offer: "Offer",
  unsure: "Unsure",
  fyi: "FYI",
};

/** Returns `text` with its first letter in upper case: "an agent" becomes "An agent". */
const upperFirst = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** Returns the word of a signal's kind: `review-requested` for `github/review-requested`, `proposal` for `proposal`. */
const readSignalWord = (kind: string): string => kind.slice(kind.indexOf("/") + 1);

/**
 * Returns the label of a signal's kind: "Mentioned" for `github/mentioned`,
 * "Review requested" for `github/review-requested`, "Proposal" for
 * `proposal`.
 *
 * A plugin declares no label for its kinds, so the label is made from the
 * word after the "/": dashes become spaces and the first letter is a
 * capital.
 */
export const nameSignalKind = (kind: string): string =>
  CORE_KIND_LABELS[kind] ?? upperFirst(readSignalWord(kind).replaceAll("-", " "));
