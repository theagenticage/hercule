import type { JSX } from "react";
import { WorkingMark } from "@hercule/ui";

/** Draws a line that waits for something, with the app's working mark. */
export function WaitLine({ children }: { readonly children: string }): JSX.Element {
  return (
    <p className="flex items-center gap-2 text-row text-muted" role="status">
      <WorkingMark />
      {children}
    </p>
  );
}
