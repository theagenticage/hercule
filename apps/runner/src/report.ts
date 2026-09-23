/** What the runner's own frames say about themselves: when, and what went wrong. */
import * as Cause from "effect/Cause";

/** An ISO-8601 instant, as this machine reads its own clock. */
export const now = (): string => new Date().toISOString();

/**
 * What went wrong, in one line, cut to the field it rides. A defect that said
 * nothing would leave the controller waiting out its deadline for an answer
 * this machine already has.
 */
export const describeCause = (cause: Cause.Cause<unknown>, limit: number): string =>
  (Cause.pretty(cause).split("\n")[0] ?? "").slice(0, limit) || "the runner could not answer";
