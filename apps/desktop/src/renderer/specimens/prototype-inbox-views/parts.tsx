/**
 * PROTOTYPE, throwaway. The few pieces every variant uses: the brand mark,
 * the desk frame with the app's real view pill, the status shape, and the
 * floating switcher that is not part of any design.
 */
import { useEffect, type CSSProperties, type JSX, type ReactNode } from "react";
import { ViewPill } from "../../screens/desk/view-pill";
import gmailUrl from "./brands/gmail.svg?url";
import linearUrl from "./brands/linear.svg?url";
import sentryUrl from "./brands/sentry.svg?url";
import githubUrl from "./brands/github.svg?url";
import slackUrl from "./brands/slack.svg?url";
import discordUrl from "./brands/discord.svg?url";
import pagerdutyUrl from "./brands/pagerduty.svg?url";
import intercomUrl from "./brands/intercom.svg?url";
import googlecalendarUrl from "./brands/googlecalendar.svg?url";
import vercelUrl from "./brands/vercel.svg?url";
import { formatCount, type Load, type SourceId, type World } from "./world";

const MARK_URL: Record<string, string> = {
  gmail: gmailUrl,
  linear: linearUrl,
  sentry: sentryUrl,
  github: githubUrl,
  slack: slackUrl,
  discord: discordUrl,
  pagerduty: pagerdutyUrl,
  intercom: intercomUrl,
  googlecalendar: googlecalendarUrl,
  vercel: vercelUrl,
};

const MARK_OF: Record<SourceId, string> = {
  gmail: "gmail",
  linear: "linear",
  sentry: "sentry",
  github: "github",
  slack: "slack",
  discord: "discord",
  pagerduty: "pagerduty",
  intercom: "intercom",
  calendar: "googlecalendar",
  vercel: "vercel",
};

/** Draws a source's brand mark in the current ink, `size` pixels square. */
export function Mark({
  source,
  size = 14,
}: {
  readonly source: SourceId;
  readonly size?: number;
}): JSX.Element {
  return (
    <span
      className="pis-mark"
      aria-hidden="true"
      style={
        {
          "--pis-mark": `url("${MARK_URL[MARK_OF[source]]!}")`,
          width: size,
          height: size,
        } as CSSProperties
      }
    />
  );
}

/**
 * Renders the desk a variant draws on: the app's toolbar row with the real
 * Inbox pill and the variant's own tools, over a scrolling page.
 */
export function Desk({
  tools,
  children,
  className = "",
  scrolls = true,
}: {
  readonly tools?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
  readonly scrolls?: boolean;
}): JSX.Element {
  return (
    <div className={`pis-desk ${className}`}>
      <div className="desk-toolbar">
        <div className="pis-tools">
          <ViewPill
            title="Inbox"
            label="Inbox views"
            choices={[
              { view: "cards", label: "Cards" },
              { view: "intake", label: "Intake" },
            ]}
            view="cards"
            onPick={() => undefined}
          />
          {tools}
        </div>
      </div>
      <div className={scrolls ? "pis-scroll" : "pis-fixed"}>{children}</div>
    </div>
  );
}

export interface VariantEntry {
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly idea: string;
}

/**
 * Renders the floating bar that switches variants and loads. It is not part
 * of any design. The arrow keys cycle the variants unless a field has focus.
 */
export function Switcher({
  variants,
  current,
  onVariant,
  load,
  onLoad,
  world,
}: {
  readonly variants: readonly VariantEntry[];
  readonly current: VariantEntry;
  readonly onVariant: (id: string) => void;
  readonly load: Load;
  readonly onLoad: (load: Load) => void;
  readonly world: World;
}): JSX.Element {
  const index = variants.indexOf(current);
  const step = (by: number): void =>
    onVariant(variants[(index + by + variants.length) % variants.length]!.id);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable], [role=tablist]")) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  const connections = world.sources.reduce((sum, s) => sum + s.connections.length, 0);
  return (
    <div className="pis-switcher" role="toolbar" aria-label="Prototype variants">
      <button type="button" onClick={() => step(-1)} aria-label="Previous variant">
        ←
      </button>
      <div className="pis-switcher-label">
        <b>
          {current.key} · {current.name}
        </b>
        <span>{current.idea}</span>
      </div>
      <button type="button" onClick={() => step(1)} aria-label="Next variant">
        →
      </button>
      <div className="pis-switcher-load" role="group" aria-label="Load">
        {(["light", "heavy", "extreme"] as const).map((l) => (
          <button key={l} type="button" aria-pressed={l === load} onClick={() => onLoad(l)}>
            {l}
          </button>
        ))}
      </div>
      <span className="pis-switcher-stats">
        {formatCount(world.things.length)} things · {world.sources.length} sources · {connections}{" "}
        connections · {world.places.length} places
      </span>
    </div>
  );
}
