/**
 * The pieces of the describe lines and outcomes that the GitHub actions a
 * Signal's answer may run share. A describe line and an outcome get the
 * answer's input as it is stored, before decoding, so they read it with
 * guards and never fail.
 */
import type { DescribeLinePart } from "@hercule/plugin-host";

/** The issue or pull request an answer's input names. */
export interface ItemAddress {
  readonly repo: string;
  readonly number: number;
}

/** Returns the string field `name` of a stored input, or undefined when it has none. */
export const readInputText = (input: unknown, name: string): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const value: unknown = (input as Record<string, unknown>)[name];
  return typeof value === "string" ? value : undefined;
};

/** Checks whether the boolean field `name` of a stored input is true. */
export const isInputFlagSet = (input: unknown, name: string): boolean =>
  typeof input === "object" && input !== null && (input as Record<string, unknown>)[name] === true;

/** Returns the repository and number a stored input names, or undefined when it names none. */
export const readItemAddress = (input: unknown): ItemAddress | undefined => {
  const repo = readInputText(input, "repo");
  if (typeof input !== "object" || input === null || repo === undefined) return undefined;
  const number: unknown = (input as Record<string, unknown>)["number"];
  return typeof number === "number" ? { repo, number } : undefined;
};

/**
 * Returns the describe line parts that name an item, such as
 * "pull request **#1293** in **acme/webshop**". `noun` is "issue" or "pull
 * request". An input that names no item gets "a GitHub <noun>".
 */
export const describeItem = (input: unknown, noun: string): ReadonlyArray<DescribeLinePart> => {
  const address = readItemAddress(input);
  if (address === undefined) return [{ kind: "text", text: `a GitHub ${noun}` }];
  return [
    { kind: "text", text: `${noun} ` },
    { kind: "marked", text: `#${String(address.number)}` },
    { kind: "text", text: " in " },
    { kind: "marked", text: address.repo },
  ];
};

/**
 * Returns the part of a describe line that shows the text a comment or a
 * review sends, ": <body>", when the stored input already holds it. A typed
 * reply's text is not in the stored input, so its line shows none, and the
 * text box beside it shows the text instead.
 */
export const describeSentText = (input: unknown): ReadonlyArray<DescribeLinePart> => {
  const body = readInputText(input, "body");
  return body === undefined
    ? []
    : [
        { kind: "text", text: ", saying " },
        { kind: "marked", text: body },
      ];
};

/** Returns how an outcome names an item: "#1293", or "the pull request" when the input names none. */
export const nameItemBriefly = (input: unknown, noun: string): string => {
  const address = readItemAddress(input);
  return address === undefined ? `the ${noun}` : `#${String(address.number)}`;
};
