/**
 * The describe lines and outcomes of the Sentry actions a Signal's answer may
 * run. A describe line and an outcome get the answer's input as it is stored,
 * before decoding, so they read it with guards and never fail.
 */
import type { DescribeLinePart } from "@hercule/plugin-host";

/** Returns the string field `name` of a stored input, or undefined when it has none. */
export const readInputText = (input: unknown, name: string): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  const value: unknown = (input as Record<string, unknown>)[name];
  return typeof value === "string" && value !== "" ? value : undefined;
};

/** Returns the name of the assignee a stored input holds, or undefined when it holds none. */
export const readAssigneeName = (input: unknown): string | undefined => {
  if (typeof input !== "object" || input === null) return undefined;
  return readInputText((input as Record<string, unknown>)["assignee"], "name");
};

/**
 * Returns the describe line parts that name an issue, such as "issue
 * **WEBSHOP-1A** in **acme/webshop**". An input that names no issue gets "a
 * Sentry issue".
 */
export const describeIssue = (input: unknown): ReadonlyArray<DescribeLinePart> => {
  const shortId = readInputText(input, "shortId");
  if (shortId === undefined) return [{ kind: "text", text: "a Sentry issue" }];
  const orgSlug = readInputText(input, "orgSlug");
  const projectSlug = readInputText(input, "projectSlug");
  const place =
    orgSlug === undefined
      ? []
      : [
          { kind: "text" as const, text: " in " },
          {
            kind: "marked" as const,
            text: projectSlug === undefined ? orgSlug : `${orgSlug}/${projectSlug}`,
          },
        ];
  return [{ kind: "text", text: "issue " }, { kind: "marked", text: shortId }, ...place];
};

/** Returns how an outcome names an issue: its short id, or "the issue" when the input names none. */
export const nameIssueBriefly = (input: unknown): string =>
  readInputText(input, "shortId") ?? "the issue";
