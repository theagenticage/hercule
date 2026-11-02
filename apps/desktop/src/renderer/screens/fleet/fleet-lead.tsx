import type { JSX } from "react";
import type { FleetLead as FleetLeadText, FleetLeadPart } from "@hercule/client-core/fleet";
import "./fleet-page.css";

/** Renders one part of the lead: the count in the "you" ink, a number in bold, any other text as it is. */
function LeadPart({ part }: { readonly part: FleetLeadPart }): JSX.Element {
  switch (part.kind) {
    case "count":
      return <span className="is-you">{part.text}</span>;
    case "number":
      return <b>{part.text}</b>;
    case "plain":
      return <>{part.text}</>;
  }
}

/**
 * Renders the top of the Fleet page: the headline ("Three machines need
 * you.") and, under it, one line of totals. A lead with no detail draws no
 * line under the headline.
 */
export function FleetLead({ lead }: { readonly lead: FleetLeadText }): JSX.Element {
  return (
    <header className="fleet-lead">
      <h2>
        {lead.headline.map((part, index) => (
          <LeadPart key={index} part={part} />
        ))}
      </h2>
      {lead.detail.length > 0 && (
        <p>
          {lead.detail.map((part, index) => (
            <LeadPart key={index} part={part} />
          ))}
        </p>
      )}
    </header>
  );
}
