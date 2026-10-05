/**
 * PROTOTYPE (#354), throwaway. The small parts of the web subagents prototype:
 * a subagent's mark, name and state word, the spawn lines in the transcript,
 * the tally above the composer, the strip that says whose Request the
 * permission card shows, the header's side pane toggle, and the knobs.
 *
 * The web marks a subagent with words and marks only: its design language
 * allows color at word and dot scale, never as a fill or a tint, and the web
 * has no per-agent hues.
 */
import type { JSX } from "react";
import { CancelledMark, DecisionMark, DoneMark, FailedMark, WorkingMark, cn } from "@hercule/ui";
import type { ProtoSubagent } from "./fixture";
import {
  describeSubagentState,
  hasOpenRequest,
  listChildren,
  listDescendants,
  listOpenRequests,
  listSubagents,
  measureSubagent,
  nameSubagent,
  open,
  SCENARIO,
  showSurface,
  showsSubagents,
  update,
  useProto,
} from "./store";

/** Renders the subagent's state mark: working, waiting on you, done, failed or stopped. */
export function SubagentMark({
  sub,
  waiting,
}: {
  readonly sub: ProtoSubagent;
  readonly waiting: boolean;
}): JSX.Element {
  switch (sub.status) {
    case "running":
      return waiting ? <DecisionMark /> : <WorkingMark />;
    case "completed":
      return <DoneMark />;
    case "failed":
      return <FailedMark />;
    case "stopped":
      return <CancelledMark />;
  }
}

/** Returns the hue of the subagent's state word, per the color doctrine. */
export const chooseStateHue = (sub: ProtoSubagent, waiting: boolean): string =>
  sub.status === "running"
    ? waiting
      ? "text-attn"
      : "text-live"
    : sub.status === "failed"
      ? "text-fail"
      : "text-muted";

/**
 * Renders the subagent's name: its description, or, for a subagent that has
 * none, the start of its brief in quotes and italics, so it never reads as a
 * real name.
 */
export function SubagentName({
  sub,
  className,
}: {
  readonly sub: ProtoSubagent;
  readonly className?: string;
}): JSX.Element {
  return (
    <span
      title={sub.description === null ? sub.brief : undefined}
      className={cn(
        "min-w-0 truncate",
        sub.description === null ? "font-normal text-muted italic" : "font-emph text-ink",
        className,
      )}
    >
      {nameSubagent(sub)}
    </span>
  );
}

/** The turns that started subagents, and whose subagents they are: `null` is the main agent. */
const SPAWN_TURNS: Readonly<Record<string, string | null>> = {
  "turn-main": null,
  "t-ideal": "toolu_01iDeAL5nRt8uVw2XyZ3aBc6",
};

/**
 * Renders one line per subagent the turn started: its mark, its name, and its
 * state and duration, with how many subagents it started in turn and whether
 * one of them waits on the user. A line opens the subagent's page.
 */
export function SpawnLines({ turnId }: { readonly turnId: string }): JSX.Element | null {
  const s = useProto();
  if (!(turnId in SPAWN_TURNS)) return null;
  const subagents = listSubagents(s);
  const started = listChildren(subagents, SPAWN_TURNS[turnId]!);
  return (
    <ul aria-label="Subagents started here" className="-mx-2 flex flex-col">
      {started.map((sub) => {
        const waiting = hasOpenRequest(s, sub.id);
        const below = listDescendants(subagents, sub.id);
        const waitingBelow = below.some((each) => hasOpenRequest(s, each.id));
        return (
          <li key={sub.id}>
            <button
              type="button"
              onClick={() => open(sub.id)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-control px-2 py-[3px] text-left text-row hover:bg-line-soft focus-visible:outline-2 focus-visible:outline-live"
            >
              <span aria-hidden="true" className="text-faint">
                ↳
              </span>
              <span className="flex w-3 shrink-0 justify-center">
                <SubagentMark sub={sub} waiting={waiting} />
              </span>
              <SubagentName sub={sub} />
              <span className="shrink-0 text-meta whitespace-nowrap text-muted">
                <span className={chooseStateHue(sub, waiting)}>
                  {describeSubagentState(sub, waiting)}
                </span>
                {" · "}
                <span className="font-mono text-fine tabular-nums">{measureSubagent(sub)}</span>
                {below.length > 0 ? ` · ${String(below.length)} below` : null}
                {waitingBelow ? <span className="text-attn"> · one waits on you</span> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Renders the tally above the composer: how many subagents run, out of how
 * many. A click shows the Subagents surface in the side pane; a second click
 * hides the pane.
 */
export function TallyPill(): JSX.Element | null {
  const s = useProto();
  const subagents = listSubagents(s);
  if (subagents.length === 0) return null;
  const running = subagents.filter((sub) => sub.status === "running").length;
  const waiting = listOpenRequests(s).some((request) => request.subagentId !== null);
  const shown = showsSubagents(s);
  return (
    <div className="flex px-1">
      <button
        type="button"
        aria-pressed={shown}
        title={shown ? "Hide the side pane" : "Show the subagents in the side pane"}
        onClick={() => (shown ? update({ pane: false, picker: false }) : showSurface("subagents"))}
        className={cn(
          "inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-line bg-raised py-[3px] pr-[11px] pl-2 text-meta whitespace-nowrap hover:bg-line-soft hover:text-ink",
          "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
          shown ? "text-ink" : "text-muted",
        )}
      >
        <span className="flex w-3 shrink-0 justify-center">
          {running === 0 ? <DoneMark /> : waiting ? <DecisionMark /> : <WorkingMark />}
        </span>
        Subagents
        <span className="font-mono text-fine text-faint tabular-nums">
          {running > 0
            ? `${String(running)} of ${String(subagents.length)} running`
            : String(subagents.length)}
        </span>
      </button>
    </div>
  );
}

/**
 * Renders the strip on top of the permission card that says whose Request it
 * shows, and which of the open Requests: "‹ 1 of 2 › Read Mollie's iDEAL docs
 * asks · subagent of Check the iDEAL redirect · Open subagent". It shows
 * nothing when the main agent's Request is the only one, because the card is
 * then plainly the thread's own.
 */
export function RequestPager(): JSX.Element | null {
  const s = useProto();
  const requests = listOpenRequests(s);
  const subagents = listSubagents(s);
  const current = requests[s.requestIndex];
  if (current === undefined) return null;
  const asker = subagents.find((sub) => sub.id === current.subagentId);
  if (asker === undefined && requests.length === 1) return null;
  const parent =
    asker === undefined ? undefined : subagents.find((sub) => sub.id === asker.parentId);
  return (
    <div className="mx-3.5 flex items-center gap-1.5 px-3 pb-1.5 text-fine text-muted">
      {requests.length > 1 ? (
        <span className="flex shrink-0 items-center gap-0.5">
          <PagerButton
            label="Previous Request"
            disabled={s.requestIndex === 0}
            onClick={() => update({ requestIndex: s.requestIndex - 1 })}
          >
            ‹
          </PagerButton>
          <span className="font-mono tabular-nums">
            {s.requestIndex + 1} of {requests.length}
          </span>
          <PagerButton
            label="Next Request"
            disabled={s.requestIndex === requests.length - 1}
            onClick={() => update({ requestIndex: s.requestIndex + 1 })}
          >
            ›
          </PagerButton>
        </span>
      ) : null}
      {asker === undefined ? (
        <span className="min-w-0 truncate">The main agent asks</span>
      ) : (
        <>
          <span className="min-w-0 truncate">
            <span className="font-emph text-ink">{nameSubagent(asker)}</span> asks · subagent of{" "}
            {parent === undefined ? "the main agent" : nameSubagent(parent)}
          </span>
          <button
            type="button"
            onClick={() => open(asker.id)}
            className="ml-auto shrink-0 cursor-pointer rounded-control px-1.5 py-0.5 font-emph text-ink hover:bg-line-soft"
          >
            Open subagent
          </button>
        </>
      )}
    </div>
  );
}

function PagerButton({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  readonly children: string;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-5 cursor-pointer items-center justify-center rounded-control text-body leading-none enabled:hover:bg-line-soft enabled:hover:text-ink disabled:cursor-not-allowed disabled:text-faint"
    >
      {children}
    </button>
  );
}

/** Renders the header's toggle for the side pane, in the shape of the header's other actions. */
export function PaneToggle(): JSX.Element {
  const s = useProto();
  return (
    <button
      type="button"
      aria-label={s.pane ? "Hide the side pane" : "Show the side pane"}
      title={s.pane ? "Hide the side pane" : "Show the side pane"}
      aria-pressed={s.pane}
      onClick={() => update({ pane: !s.pane, picker: false })}
      className={cn(
        "flex h-[1lh] cursor-pointer items-center box-content rounded-full border border-line bg-raised px-[9px] py-[3px] text-meta hover:bg-line-soft hover:text-ink",
        s.pane ? "text-ink" : "text-muted",
      )}
    >
      <svg
        viewBox="0 0 12 12"
        className="size-3"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.15}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x={1.5} y={2} width={9} height={8} rx={1.5} />
        <path d="M7.5 2v8" />
        {s.pane ? <path d="M8.6 4.2h.9M8.6 6h.9" /> : null}
      </svg>
    </button>
  );
}

/**
 * Renders the floating knob for the scenario's state. `?knobs=off` hides it.
 * The theme has no knob: the shell's own theme switch, at the foot of the
 * sidebar, changes it.
 */
export function Knobs(): JSX.Element | null {
  if (new URLSearchParams(location.search).get("knobs") === "off") return null;
  const goState = (state: "busy" | "idle"): void => {
    const next = new URLSearchParams(location.search);
    next.set("state", state);
    location.assign(`${location.pathname}?${next.toString()}`);
  };
  return (
    <div
      role="toolbar"
      aria-label="Prototype knobs"
      // Above the sidebar's foot, so it covers neither the shell's theme
      // switch nor anything the prototype is about.
      className="fixed bottom-[128px] left-3 z-50 flex items-center gap-3 rounded-full border border-line bg-raised px-3 py-1.5 text-fine text-muted shadow-lift"
    >
      <Segment
        label="State"
        options={[
          { value: "busy", name: "Working" },
          { value: "idle", name: "Idle" },
        ]}
        value={SCENARIO.state}
        onPick={goState}
      />
    </div>
  );
}

function Segment<T extends string>({
  label,
  options,
  value,
  onPick,
}: {
  readonly label: string;
  readonly options: readonly { readonly value: T; readonly name: string }[];
  readonly value: T;
  readonly onPick: (value: T) => void;
}): JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-label tracking-[0.1em] text-faint uppercase">{label}</span>
      {options.map((each) => (
        <button
          key={each.value}
          type="button"
          aria-pressed={value === each.value}
          onClick={() => onPick(each.value)}
          className={cn(
            "cursor-pointer rounded-control px-1.5 py-0.5 hover:bg-line-soft",
            value === each.value ? "bg-line-soft font-emph text-ink" : "",
          )}
        >
          {each.name}
        </button>
      ))}
    </span>
  );
}
