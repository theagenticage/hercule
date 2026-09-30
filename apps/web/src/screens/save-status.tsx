import type { JSX } from "react";

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
