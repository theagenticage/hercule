/**
 * The warning that entity ingest keeps on a Connection: one sentence per kind
 * and problem. The warning of a Connection is shared with account setup, so
 * ingest replaces a warning only when it is empty or is exactly one of its own
 * sentences for a kind the Connection has, and clears it only when it is one
 * of them. Anything else is account setup's and is left as it is.
 */

/** Builds the warning for a complete read that could only be done in part. */
export const buildIncompleteWarning = (kind: string): string =>
  `The Inbox may be missing items: the ${kind} list could only be read in part.`;

/** Builds the warning for a relationship that was ignored because it would close a loop. */
export const buildConflictWarning = (kind: string): string =>
  `The Inbox ignored a relationship of ${kind} that would make a thing part of itself.`;

/**
 * Decides what the Connection's warning should become after a read of
 * `kind`, and returns it: a sentence, or null to clear it. Returns undefined
 * when the warning stays as it is.
 *
 * - `unresolved` is the warning each kind still has, sorted by kind.
 * - `scannedKinds` are the kinds the Connection has scanned completely.
 * - A warning that still describes an unresolved kind stays. Otherwise the
 *   first unresolved kind (by name) is shown.
 * - The warning is cleared only when no kind is unresolved.
 */
export const decideConnectionWarning = (input: {
  readonly current: string | undefined;
  readonly kind: string;
  readonly unresolved: ReadonlyArray<{ readonly kind: string; readonly warning: string }>;
  readonly scannedKinds: ReadonlyArray<string>;
}): string | null | undefined => {
  const { current } = input;
  const ownKinds = new Set([
    input.kind,
    ...input.unresolved.map((row) => row.kind),
    ...input.scannedKinds,
  ]);
  const isOwn =
    current === undefined ||
    [...ownKinds].some(
      (kind) => current === buildIncompleteWarning(kind) || current === buildConflictWarning(kind),
    );
  if (!isOwn) return undefined;
  const shown =
    input.unresolved.find((row) => row.warning === current)?.warning ??
    input.unresolved[0]?.warning;
  return shown === current ? undefined : (shown ?? null);
};
