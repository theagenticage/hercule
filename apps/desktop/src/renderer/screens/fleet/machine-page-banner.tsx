import type { JSX } from "react";
import type { OfflineBanner } from "@hercule/client-core/machine-page";
import "./machine-page.css";

/**
 * Renders the banner of an offline or unreachable machine: what happened and
 * how to start the machine again, with the command drawn as code, and Retire…
 * at the right end. Pressing Retire… calls `onRetire`.
 */
export function MachinePageBanner({
  banner,
  onRetire,
}: {
  readonly banner: OfflineBanner;
  readonly onRetire: () => void;
}): JSX.Element {
  return (
    <div className="machine-page-banner">
      <div>
        <p>{banner.headline}</p>
        <span>
          {banner.before}
          <code>{banner.command}</code>
          {banner.after}
        </span>
      </div>
      <button type="button" className="btn btn--sm btn--danger" onClick={onRetire}>
        Retire…
      </button>
    </div>
  );
}
