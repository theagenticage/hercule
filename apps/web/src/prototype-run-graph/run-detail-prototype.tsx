/**
 * PROTOTYPE - throwaway (P021 run graph, branch prototype/P021-run-graph).
 *
 * Question: what should the live run graph on a run's detail page look like?
 * Four variants of the run detail page at /runs/prototype-graph, switchable
 * with `?variant=A|B|C|D` and the floating bar at the bottom. The bar also
 * picks a scripted run (`?scenario=success|failed|cancelled`), scrubs through
 * its frames (`?frame=`), and plays it through in real time.
 */
import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Button, LaneLabel, cn } from "@hercule/ui";
import {
  buildStepViews,
  formatClockTime,
  formatSeconds,
  INPUTS,
  PLAN_GRAPH,
  RUN_ID,
  RUNS,
  SCENARIOS,
  STEP_ACTIONS,
  STEP_IDS,
  STEP_OUTPUTS,
  WORKFLOW_NAME,
  type Frame,
  type RunStatus,
  type Scenario,
  type StepView,
} from "./run-data";
import { measureStepSeconds, RunGraphView, StepStateMark, type Variant } from "./run-graph-view";

const VARIANTS: ReadonlyArray<Variant> = ["A", "B", "C", "D"];
const VARIANT_NAMES: Record<Variant, string> = {
  A: "Calm",
  B: "Flowing",
  C: "Spotlight",
  D: "Timeline",
};

export interface PrototypeSearch {
  readonly variant: Variant;
  readonly scenario: Scenario;
  readonly frame: number;
}

/**
 * The time a paused frame shows: a little after the frame began, so a
 * running step shows a plausible elapsed time rather than 0.0s.
 */
const findRestingClock = (frames: ReadonlyArray<Frame>, index: number): number => {
  const frame = frames[index]!;
  const next = frames[index + 1];
  return next === undefined ? frame.at : frame.at + (next.at - frame.at) * 0.6;
};

const findFrameAt = (frames: ReadonlyArray<Frame>, clock: number): number =>
  frames.reduce((found, frame, index) => (frame.at <= clock ? index : found), 0);

export function RunDetailPrototype({
  search,
  onSearchChange,
}: {
  readonly search: PrototypeSearch;
  readonly onSearchChange: (next: PrototypeSearch) => void;
}): JSX.Element {
  const frames = RUNS[search.scenario];
  const frameIndex = Math.min(Math.max(0, search.frame), frames.length - 1);
  const [playClock, setPlayClock] = useState<number | null>(null);
  const playing = playClock !== null;
  const shownIndex = playing ? findFrameAt(frames, playClock) : frameIndex;
  const clock = playing ? playClock : findRestingClock(frames, frameIndex);
  const frame = frames[shownIndex]!;
  const views = buildStepViews(frame);

  // Plays the run in real time, one animation frame at a time. The URL
  // follows the frame, so a paused run can be shared.
  const latest = useRef({ search, onSearchChange, frames });
  latest.current = { search, onSearchChange, frames };
  useEffect(() => {
    if (!playing) return;
    let last = performance.now();
    let handle = requestAnimationFrame(function tick(now) {
      const step = (now - last) / 1000;
      last = now;
      setPlayClock((previous) => {
        if (previous === null) return null;
        const next = previous + step;
        const { frames: all } = latest.current;
        const end = all.at(-1)!.at;
        if (next >= end + 0.8) return null;
        return next;
      });
      handle = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(handle);
  }, [playing]);
  useEffect(() => {
    if (playClock === null) return;
    const index = findFrameAt(frames, playClock);
    if (index !== latest.current.search.frame)
      latest.current.onSearchChange({ ...latest.current.search, frame: index });
  }, [playClock, frames]);

  const togglePlay = () => {
    if (playing) {
      setPlayClock(null);
      return;
    }
    const startIndex = frameIndex === frames.length - 1 ? 0 : frameIndex;
    if (startIndex !== frameIndex) onSearchChange({ ...search, frame: startIndex });
    setPlayClock(frames[startIndex]!.at);
  };

  const cycleVariant = (by: number) => {
    const index = VARIANTS.indexOf(search.variant);
    onSearchChange({
      ...search,
      variant: VARIANTS[(index + by + VARIANTS.length) % VARIANTS.length]!,
    });
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, [contenteditable]") !== null && target !== null) return;
      if (event.key === "ArrowLeft") cycleVariant(-1);
      else if (event.key === "ArrowRight") cycleVariant(1);
      else if (event.key === " ") {
        event.preventDefault();
        togglePlay();
      } else return;
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const runSeconds = frame.status === "pending" ? 0 : clock;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pb-32">
      <RunHeader status={frame.status} seconds={runSeconds} frame={frame} />
      <div className="flex flex-col gap-6 px-8 pt-5">
        <section aria-label="Plan">
          <div className="flex items-baseline justify-between">
            <LaneLabel>Plan</LaneLabel>
            <span className="mb-2.5 text-fine text-faint">
              Frozen when the run started, 14:02:10
            </span>
          </div>
          <div
            className={cn(
              "overflow-hidden rounded-card border border-line bg-surface",
              search.variant === "C" ? "h-[300px]" : "h-[260px]",
            )}
          >
            <RunGraphView
              graph={PLAN_GRAPH}
              variant={search.variant}
              views={views}
              clock={clock}
              runStatus={frame.status}
            />
          </div>
        </section>
        <div className="flex items-start gap-8">
          <section aria-label="Steps" className="min-w-0 flex-1">
            <LaneLabel>Steps</LaneLabel>
            {search.variant === "D" ? (
              <StepTimeline frames={frames} views={views} clock={clock} status={frame.status} />
            ) : (
              <StepList views={views} clock={clock} status={frame.status} />
            )}
          </section>
          <InputsCard />
        </div>
      </div>
      <PrototypeBar
        search={search}
        frames={frames}
        shownIndex={shownIndex}
        playing={playing}
        onSearchChange={(next) => {
          setPlayClock(null);
          onSearchChange(next);
        }}
        onVariantChange={(next) => onSearchChange({ ...search, variant: next })}
        onCycle={cycleVariant}
        onTogglePlay={togglePlay}
      />
    </div>
  );
}

const RUN_WORD_CLASS: Partial<Record<RunStatus, string>> = {
  running: "text-live",
  failed: "text-fail",
};

function RunHeader({
  status,
  seconds,
  frame,
}: {
  readonly status: RunStatus;
  readonly seconds: number;
  readonly frame: Frame;
}): JSX.Element {
  const failed = frame.records.find((record) => record.status === "failed");
  const word =
    status === "pending"
      ? "pending"
      : status === "running"
        ? `running ${formatSeconds(seconds)}`
        : status === "completed"
          ? `completed in ${formatSeconds(frame.at)}`
          : status === "failed"
            ? `failed after ${formatSeconds(frame.at)}`
            : `cancelled by you after ${formatSeconds(frame.at)}`;
  const canCancel = status === "pending" || status === "running";
  return (
    <header className="shrink-0 px-8 pt-[22px]">
      <div className="flex h-[1lh] items-center justify-between gap-4 text-title">
        <div className="flex min-w-0 items-baseline gap-2 tracking-[-0.015em]">
          <Link
            to="/runs"
            className="-mx-1 shrink-0 rounded-control px-1 text-muted hover:text-ink"
          >
            Runs
          </Link>
          <span aria-hidden="true" className="text-faint">
            /
          </span>
          <h1 className="min-w-0 truncate font-emph text-ink">{WORKFLOW_NAME}</h1>
        </div>
        {canCancel ? (
          <Button variant="quiet" className="h-8 px-3 text-body">
            Cancel run
          </Button>
        ) : null}
      </div>
      <div className="mt-1.5 flex h-5 items-center gap-2 text-meta text-muted">
        <StepStateMark state={status} />
        <span className={cn("font-emph", RUN_WORD_CLASS[status] ?? "text-ink")}>{word}</span>
        {failed === undefined ? null : (
          <>
            <Dot />
            <span>
              step <span className="font-mono text-ink">{failed.stepId}</span> failed
            </span>
          </>
        )}
        <Dot />
        <span>started by you</span>
        <Dot />
        <span>manual trigger</span>
        <Dot />
        <span className="font-mono text-fine tabular-nums">{formatClockTime(0)}</span>
        <Dot />
        <span className="font-mono text-fine text-faint">{`run ${RUN_ID.slice(0, 6)}…${RUN_ID.slice(-4)}`}</span>
      </div>
    </header>
  );
}

function Dot(): JSX.Element {
  return (
    <span aria-hidden="true" className="text-faint">
      ·
    </span>
  );
}

function InputsCard(): JSX.Element {
  return (
    <section aria-label="Inputs" className="w-[340px] shrink-0">
      <LaneLabel>Inputs</LaneLabel>
      <dl className="flex flex-col gap-2 rounded-card border border-line-soft bg-surface px-4 py-3">
        {INPUTS.map(([key, value]) => (
          <div key={key} className="grid grid-cols-[72px_minmax(0,1fr)] items-baseline gap-3">
            <dt className="font-mono text-fine text-muted">{key}</dt>
            <dd className="truncate font-mono text-fine text-ink">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The word for a step's state in the step list. */
const describeStep = (view: StepView, status: RunStatus): string => {
  switch (view.state) {
    case "pending":
      return "queued";
    case "running":
      return "running";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "unreached":
      return status === "completed" || status === "failed" || status === "cancelled"
        ? "not reached"
        : "not started";
  }
};

const STEP_WORD_CLASS: Partial<Record<StepView["state"], string>> = {
  running: "text-live",
  failed: "text-fail",
  completed: "text-ink",
};

/** The step list of variants A to C: one row per step, in plan order. */
function StepList({
  views,
  clock,
  status,
}: {
  readonly views: ReadonlyMap<string, StepView>;
  readonly clock: number;
  readonly status: RunStatus;
}): JSX.Element {
  const [open, setOpen] = useState<string | undefined>();
  return (
    <div className="rounded-card border border-line-soft bg-surface px-1.5 py-1">
      {STEP_IDS.map((stepId) => {
        const view = views.get(stepId)!;
        const seconds = measureStepSeconds(view, clock);
        const hasOutput = view.state === "completed";
        const isOpen = open === stepId && hasOutput;
        const unreached = view.state === "unreached";
        return (
          <div key={stepId} className="border-b border-line-soft last:border-b-0">
            <button
              type="button"
              disabled={!hasOutput}
              onClick={() => setOpen(isOpen ? undefined : stepId)}
              className="grid min-h-10 w-full grid-cols-[20px_minmax(0,1fr)_96px_80px_64px_16px] items-center gap-3 rounded-control px-2.5 text-left enabled:hover:bg-line-soft"
            >
              <span className="flex items-center">
                <StepStateMark state={view.state} />
              </span>
              <span className="flex min-w-0 items-baseline gap-2.5">
                <span
                  className={`truncate font-mono text-row font-emph ${unreached ? "text-muted" : "text-ink"}`}
                >
                  {stepId}
                </span>
                <span className="font-mono text-fine text-faint">{STEP_ACTIONS[stepId]}</span>
              </span>
              <span className="font-mono text-fine text-faint tabular-nums">
                {view.record?.startedAt === undefined ? "" : formatClockTime(view.record.startedAt)}
              </span>
              <span className={cn("text-meta", STEP_WORD_CLASS[view.state] ?? "text-faint")}>
                {describeStep(view, status)}
              </span>
              <span className="text-right font-mono text-fine text-muted tabular-nums">
                {seconds === undefined ? "" : formatSeconds(seconds)}
              </span>
              <span className="flex justify-end text-faint">
                {hasOutput ? <Chevron open={isOpen} /> : null}
              </span>
            </button>
            {view.record?.error === undefined ? null : (
              <p className="pb-2.5 pl-[44px] text-fine text-fail">
                <span className="font-mono">{view.record.error.code}</span>
                {` · ${view.record.error.message}`}
              </p>
            )}
            {isOpen ? (
              <pre className="mx-2.5 mb-2.5 ml-[42px] overflow-x-auto rounded-control border border-line-soft bg-raised px-3 py-2 font-mono text-fine leading-5 text-ink">
                {STEP_OUTPUTS[stepId]}
              </pre>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function Chevron({ open }: { readonly open: boolean }): JSX.Element {
  return (
    <svg
      viewBox="0 0 12 12"
      width={12}
      height={12}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.15}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={cn("transition-transform", open && "rotate-90")}
    >
      <path d="m4.5 2.5 3.5 3.5-3.5 3.5" />
    </svg>
  );
}

/**
 * Variant D's step list: a ledger with a time track per step. Each step that
 * started has a bar from its start to its end, or to now while it runs; a
 * vertical line marks now.
 */
function StepTimeline({
  frames,
  views,
  clock,
  status,
}: {
  readonly frames: ReadonlyArray<Frame>;
  readonly views: ReadonlyMap<string, StepView>;
  readonly clock: number;
  readonly status: RunStatus;
}): JSX.Element {
  // The scale covers the whole scripted run, so it does not jump while playing.
  const span = Math.ceil((frames.at(-1)!.at + 0.4) / 2) * 2;
  const ticks = Array.from({ length: span / 2 + 1 }, (_, index) => index * 2);
  const finished = status === "completed" || status === "failed" || status === "cancelled";
  const now = finished ? frames.at(-1)!.at : clock;
  const toPercent = (seconds: number): string => `${String((seconds / span) * 100)}%`;
  const track = (children: ReactNode) => <div className="relative h-full">{children}</div>;
  return (
    <div className="rounded-card border border-line-soft bg-surface px-1.5 py-1">
      <div className="grid h-10 grid-cols-[20px_220px_minmax(0,1fr)_64px] items-end gap-3 px-2.5 pb-1.5">
        <span />
        <span />
        {track(
          <>
            {ticks.map((tick) => (
              <span
                key={tick}
                style={{ left: toPercent(tick) }}
                className={cn(
                  "absolute bottom-0 font-mono text-label text-faint tabular-nums",
                  tick === 0 ? "" : tick === span ? "-translate-x-full" : "-translate-x-1/2",
                )}
              >
                {`${String(tick)}s`}
              </span>
            ))}
            {finished ? null : (
              <span
                style={{ left: toPercent(now) }}
                className="absolute top-0 -translate-x-1/2 rounded-control bg-surface px-1 font-mono text-label text-live tabular-nums"
              >
                {`now ${formatSeconds(now)}`}
              </span>
            )}
          </>,
        )}
        <span />
      </div>
      <div className="relative">
        {STEP_IDS.map((stepId) => {
          const view = views.get(stepId)!;
          const seconds = measureStepSeconds(view, clock);
          const record = view.record;
          const unreached = view.state === "unreached";
          const end = record?.finishedAt ?? clock;
          return (
            <div key={stepId} className="border-t border-line-soft">
              <div className="grid min-h-10 grid-cols-[20px_220px_minmax(0,1fr)_64px] items-center gap-3 px-2.5">
                <span className="flex items-center">
                  <StepStateMark state={view.state} />
                </span>
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="w-5 font-mono text-fine text-faint tabular-nums">
                    {view.order === undefined ? "" : `#${String(view.order)}`}
                  </span>
                  <span
                    className={`truncate font-mono text-row font-emph ${unreached ? "text-muted" : "text-ink"}`}
                  >
                    {stepId}
                  </span>
                  <span className="truncate font-mono text-fine text-faint">
                    {STEP_ACTIONS[stepId]}
                  </span>
                </span>
                {track(
                  <>
                    {ticks.map((tick) => (
                      <span
                        key={tick}
                        style={{ left: toPercent(tick) }}
                        className="absolute inset-y-0 w-px bg-line-soft"
                      />
                    ))}
                    {record?.startedAt === undefined ? (
                      view.state === "pending" ? (
                        <span
                          style={{ left: toPercent(now) }}
                          className="absolute top-1/2 ml-2 -translate-y-1/2 text-fine text-faint"
                        >
                          queued
                        </span>
                      ) : view.state === "cancelled" ? (
                        <span
                          style={{ left: toPercent(record?.finishedAt ?? now) }}
                          className="absolute top-1/2 ml-2 -translate-y-1/2 text-fine text-faint"
                        >
                          cancelled before it started
                        </span>
                      ) : null
                    ) : (
                      <span
                        style={{
                          left: toPercent(record.startedAt),
                          width: toPercent(Math.max(0, end - record.startedAt)),
                        }}
                        className={cn(
                          "absolute top-1/2 h-1.5 -translate-y-1/2 rounded-full",
                          view.state === "running" && "bg-live",
                          view.state === "completed" &&
                            "bg-[color-mix(in_oklch,var(--muted)_50%,transparent)]",
                          view.state === "failed" && "bg-fail",
                          view.state === "cancelled" &&
                            "bg-[color-mix(in_oklch,var(--faint)_45%,transparent)]",
                        )}
                      >
                        {view.state === "running" ? (
                          <span className="proto-head absolute top-1/2 -right-1 size-2.5 -translate-y-1/2 rounded-full bg-[color-mix(in_oklch,var(--live)_35%,transparent)]" />
                        ) : null}
                      </span>
                    )}
                  </>,
                )}
                <span
                  className={cn(
                    "text-right font-mono text-fine tabular-nums",
                    view.state === "running" ? "text-live" : "text-muted",
                  )}
                >
                  {seconds === undefined ? "" : formatSeconds(seconds)}
                </span>
              </div>
              {record?.error === undefined ? null : (
                <p className="pb-2.5 pl-[42px] text-fine text-fail">
                  <span className="font-mono">{record.error.code}</span>
                  {` · ${record.error.message}`}
                </p>
              )}
            </div>
          );
        })}
        {/* Now: one line down every track. */}
        <div className="pointer-events-none absolute inset-y-0 right-[86px] left-[274px]">
          <span
            style={{ left: toPercent(now) }}
            className={cn(
              "absolute inset-y-0 w-px",
              finished ? "bg-line" : "bg-[color-mix(in_oklch,var(--live)_70%,transparent)]",
            )}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The floating prototype bar: the variant switcher, the scripted run, the
 * scrubber and play. It is deliberately not in the design language, so it is
 * never mistaken for part of the page.
 */
function PrototypeBar({
  search,
  frames,
  shownIndex,
  playing,
  onSearchChange,
  onCycle,
  onTogglePlay,
}: {
  readonly search: PrototypeSearch;
  readonly frames: ReadonlyArray<Frame>;
  readonly shownIndex: number;
  readonly playing: boolean;
  readonly onSearchChange: (next: PrototypeSearch) => void;
  readonly onVariantChange: (next: Variant) => void;
  readonly onCycle: (by: number) => void;
  readonly onTogglePlay: () => void;
}): JSX.Element {
  const pill = "rounded-full px-2.5 py-1 hover:bg-white/10";
  return (
    <div
      data-prototype-bar=""
      className="fixed bottom-5 left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-[#111318] py-1.5 pr-4 pl-1.5 font-sans text-[12.5px] text-white/85 shadow-[0_8px_30px_rgba(0,0,0,0.35),0_0_0_1px_rgba(255,255,255,0.16)]"
    >
      <button
        type="button"
        className={pill}
        onClick={() => onCycle(-1)}
        aria-label="Previous variant"
      >
        ←
      </button>
      <span className="w-[112px] text-center font-medium text-white">
        {`${search.variant} · ${VARIANT_NAMES[search.variant]}`}
      </span>
      <button type="button" className={pill} onClick={() => onCycle(1)} aria-label="Next variant">
        →
      </button>
      <span className="mx-2 h-4 w-px bg-white/15" />
      {SCENARIOS.map((scenario) => (
        <button
          key={scenario}
          type="button"
          onClick={() =>
            onSearchChange({
              ...search,
              scenario,
              frame: Math.min(search.frame, RUNS[scenario].length - 1),
            })
          }
          className={cn(pill, search.scenario === scenario && "bg-white/15 text-white")}
        >
          {scenario[0]!.toUpperCase() + scenario.slice(1)}
        </button>
      ))}
      <span className="mx-2 h-4 w-px bg-white/15" />
      <button
        type="button"
        onClick={onTogglePlay}
        aria-label={playing ? "Pause" : "Play"}
        className="flex size-7 items-center justify-center rounded-full bg-white text-[#111318] hover:bg-white/85"
      >
        {playing ? (
          <svg viewBox="0 0 12 12" width={11} height={11} fill="currentColor" aria-hidden="true">
            <rect x={2.5} y={2} width={2.5} height={8} rx={0.6} />
            <rect x={7} y={2} width={2.5} height={8} rx={0.6} />
          </svg>
        ) : (
          <svg viewBox="0 0 12 12" width={11} height={11} fill="currentColor" aria-hidden="true">
            <path d="M3.5 1.8v8.4a.6.6 0 0 0 .9.5l6.6-4.2a.6.6 0 0 0 0-1L4.4 1.3a.6.6 0 0 0-.9.5z" />
          </svg>
        )}
      </button>
      <input
        type="range"
        min={0}
        max={frames.length - 1}
        step={1}
        value={shownIndex}
        onChange={(event) => onSearchChange({ ...search, frame: Number(event.target.value) })}
        aria-label="Run frame"
        className="mx-2 w-[160px] accent-white"
      />
      <span className="w-[230px] truncate font-mono text-[11.5px] text-white/70 tabular-nums">
        {`${String(shownIndex + 1)}/${String(frames.length)} · ${frames[shownIndex]!.caption}`}
      </span>
    </div>
  );
}
