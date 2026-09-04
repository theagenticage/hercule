import type { JSX } from "react";
import { Button, Group } from "@hydra/ui";

export interface Offer {
  readonly name: string;
  readonly gist: string;
}

/**
 * The Connect rows an empty screen offers. Connection setup does not exist yet,
 * so every button is disabled with the reason under the group: what cannot be
 * picked is dimmed with its reason, never hidden.
 */
export function ConnectRows({
  offers,
  reason,
}: {
  readonly offers: readonly Offer[];
  readonly reason: string;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2">
      <Group>
        {offers.map((offer) => (
          <div
            key={offer.name}
            className="flex items-center gap-2.5 rounded-control px-2.5 py-[7px] text-row"
          >
            <span className="min-w-0 flex-1">
              <b className="block font-emph text-ink">{offer.name}</b>
              <small className="block text-fine text-muted">{offer.gist}</small>
            </span>
            <Button variant="primary" disabled>
              Connect
            </Button>
          </div>
        ))}
      </Group>
      <p className="text-fine text-faint">{reason}</p>
    </div>
  );
}
