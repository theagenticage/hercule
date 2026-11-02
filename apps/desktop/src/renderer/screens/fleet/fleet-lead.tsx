import type { JSX } from "react";
import type { FleetLead } from "@hercule/client-core/fleet";
import { FleetText } from "./fleet-text";
import "./fleet-page.css";

/**
 * Renders the top of the Fleet page: the headline ("Three machines need
 * you.") and, under it, one line of totals. A lead with no detail draws no
 * line under the headline.
 */
export function FleetPageLead({ lead }: { readonly lead: FleetLead }): JSX.Element {
  return (
    <header className="fleet-lead">
      <h2>
        <FleetText parts={lead.headline} />
      </h2>
      {lead.detail.length > 0 && (
        <p>
          <FleetText parts={lead.detail} />
        </p>
      )}
    </header>
  );
}
