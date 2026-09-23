import type { JSX } from "react";

/**
 * Returns the message of an error. A rejected value that is not an `Error`
 * is converted to a string, so there is always something to show.
 */
export const readErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Shows the result of the last save: the error if it failed, "Saved." if it succeeded. */
export function SaveStatus({
  saved,
  failure,
}: {
  readonly saved: boolean;
  readonly failure: string | null;
}): JSX.Element | null {
  if (failure !== null) {
    return (
      <p className="text-fine text-fail" role="alert">
        {failure}
      </p>
    );
  }
  if (!saved) return null;
  return (
    <p className="text-fine text-muted" role="status">
      Saved.
    </p>
  );
}
