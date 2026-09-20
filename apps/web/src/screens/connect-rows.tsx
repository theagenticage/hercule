import type { JSX } from "react";
import { Button, Group } from "@hercule/ui";

export interface Offer {
  readonly name: string;
  readonly gist: string;
  /**
   * What Connect does. An offer without one is dimmed: a screen whose setup is
   * not built yet still shows what will be there, with the reason under it.
   */
  readonly onConnect?: () => void;
}

/**
 * The Connect rows a screen offers. What cannot be picked is dimmed with its
 * reason under the group, never hidden.
 */
export function ConnectRows({
  offers,
  reason,
}: {
  readonly offers: readonly Offer[];
  readonly reason?: string;
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
            <Button
              variant="primary"
              disabled={offer.onConnect === undefined}
              onClick={offer.onConnect}
            >
              Connect
            </Button>
          </div>
        ))}
      </Group>
      {reason === undefined ? null : <p className="text-fine text-faint">{reason}</p>}
    </div>
  );
}
