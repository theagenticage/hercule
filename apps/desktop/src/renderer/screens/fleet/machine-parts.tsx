import type { JSX, ReactNode } from "react";
import type {
  GaugeLevel,
  MachineGauge,
  MachineNeed,
  MachineStatus,
} from "@hercule/client-core/fleet";
import "./machine-parts.css";

/**
 * Renders the dot before a machine's status: green while it is online, a red
 * ring while it is offline or unreachable, a grey ring while it takes no new
 * work. The dot is decoration, hidden from assistive technology, because a
 * label is drawn beside it. Set `namesState` where none is (a card of an online
 * machine), and the dot then names its state itself, such as "Online".
 */
export function StatusDot({
  status,
  namesState,
}: {
  readonly status: MachineStatus;
  readonly namesState?: boolean;
}): JSX.Element {
  const className = `fleet-dot fleet-dot--${status.tone}`;
  return namesState === true ? (
    <i className={className} role="img" aria-label={status.label} />
  ) : (
    <i className={className} aria-hidden="true" />
  );
}

/**
 * Renders a bar that is `share` full, from 0 to 1, in the colour of `level`.
 * A `share` of `null` draws it empty, for a gauge whose total is not known. The
 * percentage is drawn beside it, so the bar is hidden from assistive
 * technology.
 */
export function Meter({
  share,
  level,
}: {
  readonly share: number | null;
  readonly level: GaugeLevel;
}): JSX.Element {
  return (
    <span className={`fleet-meter fleet-meter--${level}`} aria-hidden="true">
      <i style={{ width: `${(share ?? 0) * 100}%` }} />
    </span>
  );
}

/**
 * Renders a gauge's big number with its unit in small after it. A unit of ""
 * draws no unit, as for a gauge with nothing reported.
 */
export function GaugeValue({
  gauge,
}: {
  readonly gauge: Pick<MachineGauge, "value" | "unit">;
}): JSX.Element {
  return (
    <b>
      {gauge.value}
      {gauge.unit === "" ? null : <small>{gauge.unit}</small>}
    </b>
  );
}

/**
 * Renders the line that says what a machine needs from the user, with the
 * button that fixes it, as siblings for the parent to lay out. Renders nothing
 * when the machine needs nothing.
 *
 * - A waiting need has `allow`, the button that raises the session cap, which
 *   the caller builds because it owns what pressing it does.
 * - A disk below its limit, or 85% full or more, has `Clean up…`, drawn inert
 *   because the cleanup dialog is not built yet. It stays `aria-disabled`
 *   rather than `disabled` so its tooltip still shows.
 * - An offline or unreachable machine has no button.
 */
export function NeedLine({
  need,
  allow,
}: {
  readonly need: MachineNeed | undefined;
  readonly allow: ReactNode;
}): JSX.Element | null {
  if (need === undefined) return null;
  const hasCleanUp = need.kind === "disk-below-limit" || need.kind === "disk-nearly-full";
  return (
    <>
      <span className={`fleet-attn is-${need.hue}`} title={need.line}>
        {need.line}
      </span>
      {need.kind === "waiting" && allow}
      {hasCleanUp && (
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
