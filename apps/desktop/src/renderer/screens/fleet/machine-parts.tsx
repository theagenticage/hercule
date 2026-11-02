import type { JSX } from "react";
import type { GaugeLevel, MachineNeed, MachineStatus } from "@hercule/client-core/fleet";
import "./fleet-page.css";

/**
 * Renders the dot before a machine's status: green while it is online, a red
 * ring while it is offline or unreachable, a grey ring while it takes no new
 * work. The dot names its state itself ("Online") only when no word is drawn
 * beside it.
 */
export function StatusDot({ status }: { readonly status: MachineStatus }): JSX.Element {
  const className = `fleet-dot fleet-dot--${status.tone}`;
  return status.word === null ? (
    <i className={className} role="img" aria-label="Online" />
  ) : (
    <i className={className} aria-hidden="true" />
  );
}

/**
 * Renders a bar that is `share` full, from 0 to 1, in the colour of `level`.
 * The percentage is drawn beside it, so the bar is hidden from assistive
 * technology.
 */
export function Meter({
  share,
  level,
}: {
  readonly share: number;
  readonly level: GaugeLevel;
}): JSX.Element {
  return (
    <span className={`fleet-meter fleet-meter--${level}`} aria-hidden="true">
      <i style={{ width: `${Math.min(1, Math.max(0, share)) * 100}%` }} />
    </span>
  );
}

/**
 * Renders the line that says what a machine needs from the user, with the
 * button that fixes it, as two siblings for the parent to lay out. Renders
 * nothing when the machine needs nothing.
 *
 * - A waiting need has `Allow N`, which calls `onAllow` with the machine's
 *   runner id and the cap that lets every waiting session start. While
 *   `allowPending` is true the button shows that it is saving and does nothing.
 * - A full disk has `Clean up…`, drawn inert because the cleanup dialog is not
 *   built yet. It stays `aria-disabled` rather than `disabled` so its tooltip
 *   still shows.
 * - An offline or unreachable machine has no button.
 */
export function NeedLine({
  runnerId,
  need,
  allowPending,
  onAllow,
}: {
  readonly runnerId: string;
  readonly need: MachineNeed | undefined;
  readonly allowPending: boolean;
  readonly onAllow: (runnerId: string, cap: number) => void;
}): JSX.Element | null {
  if (need === undefined) return null;
  return (
    <>
      <span className={`fleet-attn is-${need.hue}`} title={need.line}>
        {need.line}
      </span>
      {need.kind === "waiting" && (
        <button
          type="button"
          className="btn btn--sm fleet-attn-btn"
          title={need.allowHint}
          aria-disabled={allowPending || undefined}
          onClick={() => {
            if (!allowPending) onAllow(runnerId, need.allow);
          }}
        >
          {allowPending ? (
            <>
              <span className="spin" aria-hidden="true" /> Saving…
            </>
          ) : (
            `Allow ${String(need.allow)}`
          )}
        </button>
      )}
      {need.kind === "disk-below-limit" && (
        <button
          type="button"
          className="btn btn--sm fleet-attn-btn"
          aria-disabled="true"
          data-unready=""
          title="Not built yet"
        >
          Clean up…
        </button>
      )}
    </>
  );
}

/**
 * Renders the machine's name as the one button that opens the machine's page.
 * Its `::after` covers the whole card or row (the nearest positioned
 * ancestor), so pressing anywhere on it opens the page while the name stays
 * the only thing a keyboard or a screen reader meets. The Allow and Clean up
 * buttons sit above that cover.
 */
export function OpenMachine({
  runnerId,
  name,
  onOpen,
}: {
  readonly runnerId: string;
  readonly name: string;
  readonly onOpen: (runnerId: string) => void;
}): JSX.Element {
  return (
    <button type="button" className="fleet-open" onClick={() => onOpen(runnerId)}>
      <span>{name}</span>
    </button>
  );
}
