import type { JSX } from "react";

/** A rejection that is not an Error still has to say something. */
export const readErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** What the last write did, where the user can see it. */
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
