/**
 * PROTOTYPE (#354), throwaway. The side pane beside the shell's main column:
 * tabs of surfaces (browser, terminal, files, diff, pull request, subagents),
 * "+" to open another, and the shown surface. The user resizes it by dragging
 * its left edge. Only the Subagents surface is drawn; the rest are stubs.
 *
 * The pane has the page's background, as the desktop pane has the main
 * surface's: when the user opens it, it matters as much as the thread.
 */
import type { JSX, PointerEvent as ReactPointerEvent } from "react";
import { LaneLabel, cn } from "@hercule/ui";
import type { ProtoSubagent } from "./fixture";
import { chooseStateHue, SubagentMark, SubagentName } from "./parts";
import {
  formatTokens,
  hasOpenRequest,
  listChildren,
  listSubagents,
  measureSubagent,
  open,
  showSurface,
  showsSubagents,
  stopEverything,
  stopSubagent,
  type SurfaceKind,
  update,
  useProto,
} from "./store";

const SURFACES: readonly {
  readonly kind: SurfaceKind;
  readonly name: string;
  readonly key: string;
}[] = [
  { kind: "browser", name: "Browser", key: "B" },
  { kind: "terminal", name: "Terminal", key: "T" },
  { kind: "files", name: "Files", key: "F" },
  { kind: "diff", name: "Diff", key: "D" },
  { kind: "pull-request", name: "Pull request", key: "P" },
  { kind: "subagents", name: "Subagents", key: "S" },
];

const nameSurface = (kind: SurfaceKind): string =>
  SURFACES.find((each) => each.kind === kind)!.name;

const MIN_PANE = 300;
const MIN_MAIN = 520;

/** Renders the strip on the pane's left edge that resizes it by dragging. */
function ResizeHandle(): JSX.Element {
  const start = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const handle = event.currentTarget;
    const pane = handle.parentElement!;
    const right = pane.getBoundingClientRect().right;
    // The main column is the pane's previous sibling; it keeps at least MIN_MAIN.
    const mainLeft = pane.previousElementSibling!.getBoundingClientRect().left;
    handle.setPointerCapture(event.pointerId);
    const move = (moved: PointerEvent): void => {
      const max = right - mainLeft - MIN_MAIN;
      update({ paneWidth: Math.round(Math.min(max, Math.max(MIN_PANE, right - moved.clientX))) });
    };
    const end = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", end);
      handle.removeEventListener("pointercancel", end);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side pane"
      onPointerDown={start}
      className="absolute inset-y-0 -left-[3px] z-20 w-[6px] cursor-col-resize hover:bg-line-soft"
    />
  );
}

/** Renders the "+" menu that opens a surface; a surface's letter opens it too. */
function SurfacePicker(): JSX.Element {
  return (
    <div
      role="menu"
      aria-label="Open a surface"
      tabIndex={-1}
      ref={(menu) => menu?.focus()}
      onKeyDown={(event) => {
        if (event.key === "Escape") update({ picker: false });
        const chosen = SURFACES.find((each) => each.key === event.key.toUpperCase());
        if (chosen !== undefined) showSurface(chosen.kind);
      }}
      className="absolute top-[calc(100%+6px)] left-0 z-30 flex w-52 flex-col rounded-[10px] border border-line bg-raised p-1 text-body font-normal tracking-normal shadow-lift outline-none"
    >
      <span className="px-2 pt-1.5 pb-1 text-label font-emph tracking-[0.1em] text-faint uppercase">
        Open a surface
      </span>
      {SURFACES.map((each) => (
        <button
          key={each.kind}
          type="button"
          role="menuitem"
          onClick={() => showSurface(each.kind)}
          className="flex cursor-pointer items-center rounded-control px-2 py-1 text-left text-ink hover:bg-line-soft"
        >
          <span className="flex-1">{each.name}</span>
          <kbd className="font-mono text-fine text-faint">{each.key}</kbd>
        </button>
      ))}
    </div>
  );
}

/** Renders a quiet square-and-word button in the shape of the composer's Stop. */
export function StopPill({
  label,
  title,
  onStop,
}: {
  readonly label: string;
  readonly title?: string | undefined;
  readonly onStop: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        onStop();
      }}
      className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-line px-2.5 py-1 text-meta leading-[18px] font-emph text-ink hover:bg-line-soft focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
    >
      <span aria-hidden="true" className="size-2 rounded-[1.5px] bg-current" />
      {label}
    </button>
  );
}

/** Renders the side pane: the tabs of its surfaces, "+" to open another, and the shown surface. */
export function SidePane(): JSX.Element | null {
  const s = useProto();
  if (!s.pane) return null;
  const close = (kind: SurfaceKind): void => {
    const surfaces = s.surfaces.filter((each) => each !== kind);
    update(
      surfaces.length === 0
        ? { pane: false, surfaces: [], picker: false }
        : { surfaces, surface: s.surface === kind ? surfaces.at(-1)! : s.surface },
    );
  };
  return (
    <aside
      aria-label="Side pane"
      style={{ width: s.paneWidth }}
      className="relative flex shrink-0 flex-col border-l border-line-soft bg-bg"
    >
      <ResizeHandle />
      {/* The same insets and height as the thread's header row, so the tabs
          sit on the title's line across the split. */}
      <div className="shrink-0 px-4 pt-[22px] pb-3">
        <div className="flex h-[1lh] items-center gap-1.5 text-title">
          <div role="tablist" className="flex min-w-0 items-center gap-1.5">
            {s.surfaces.map((kind) => {
              const on = s.surface === kind;
              return (
                <span
                  key={kind}
                  className={cn(
                    "flex min-w-0 items-center gap-1 rounded-[8px] py-[3px] pr-1 pl-2.5 text-body tracking-normal",
                    on
                      ? "border border-line bg-raised font-emph text-ink shadow-card"
                      : "font-normal text-muted hover:text-ink",
                  )}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={on}
                    onClick={() => update({ surface: kind })}
                    className="min-w-0 cursor-pointer truncate"
                  >
                    {nameSurface(kind)}
                  </button>
                  <CloseButton label={`Close ${nameSurface(kind)}`} onClose={() => close(kind)} />
                </span>
              );
            })}
          </div>
          <span className="relative flex">
            <button
              type="button"
              aria-label="Open a surface"
              aria-expanded={s.picker}
              onClick={() => update({ picker: !s.picker })}
              className={cn(
                "flex size-6 cursor-pointer items-center justify-center rounded-control text-body hover:bg-line-soft hover:text-ink",
                s.picker ? "bg-line-soft text-ink" : "text-muted",
              )}
            >
              +
            </button>
            {s.picker ? <SurfacePicker /> : null}
          </span>
          <span className="ml-auto flex">
            <CloseButton
              label="Close the side pane"
              onClose={() => update({ pane: false, picker: false })}
            />
          </span>
        </div>
      </div>
      {showsSubagents(s) ? (
        <SubagentsSurface />
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 text-body text-muted">
          <span className="font-emph text-ink">{nameSurface(s.surface)}</span>
          Not part of this prototype.
        </div>
      )}
    </aside>
  );
}

function CloseButton({
  label,
  onClose,
}: {
  readonly label: string;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClose}
      className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-control text-faint hover:bg-line-soft hover:text-ink"
    >
      <svg
        viewBox="0 0 12 12"
        className="size-2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.3}
        strokeLinecap="round"
        aria-hidden="true"
      >
        <path d="M3 3l6 6M9 3l-6 6" />
      </svg>
    </button>
  );
}

// -------------------------------------------------- the Subagents surface

const TOOL_KINDS = new Set([
  "tool_call",
  "command_execution",
  "file_change",
  "web_search",
  "subagent",
]);

/** Counts the tool calls in a subagent's transcript, its own subagents included. */
const countTools = (sub: ProtoSubagent): number =>
  sub.rows.filter(
    (row) =>
      row.event._tag === "item.started" &&
      "kind" in row.event &&
      TOOL_KINDS.has(String(row.event.kind)),
  ).length;

/** Renders one subagent of the surface, and below it the subagents it started. */
function SubagentRow({ sub }: { readonly sub: ProtoSubagent }): JSX.Element {
  const s = useProto();
  const waiting = hasOpenRequest(s, sub.id);
  const children = listChildren(listSubagents(s), sub.id);
  const line =
    sub.status === "running"
      ? waiting
        ? "Waiting on you to allow a command"
        : sub.activity
      : sub.result;
  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        aria-current={s.open === sub.id ? "page" : undefined}
        onClick={() => open(sub.id)}
        onKeyDown={(event) => {
          if (event.key === "Enter") open(sub.id);
        }}
        className={cn(
          "flex cursor-pointer gap-2 rounded-control px-2 py-1.5 hover:bg-line-soft focus-visible:outline-2 focus-visible:outline-live",
          s.open === sub.id && "bg-line-soft",
        )}
      >
        <span className="flex h-[1lh] w-3 shrink-0 items-center justify-center text-row">
          <SubagentMark sub={sub} waiting={waiting} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-2 text-row">
            <SubagentName sub={sub} />
            <span className="ml-auto shrink-0 font-mono text-fine text-muted tabular-nums">
              {measureSubagent(sub)}
            </span>
            {sub.status === "running" ? (
              // The pill is taller than the line; it overhangs the row's
              // padding, so a running row is as tall as a settled one.
              <span className="-my-1.5 shrink-0">
                <StopPill label="Stop" onStop={() => stopSubagent(sub.id)} />
              </span>
            ) : null}
          </span>
          {line === null ? null : (
            <span className={cn("truncate text-meta", chooseStateHue(sub, waiting))}>{line}</span>
          )}
          <span className="truncate font-mono text-fine text-faint tabular-nums">
            {sub.agentType} · sonnet-5 · {formatTokens(sub.tokens)} tok · {countTools(sub)} tools
          </span>
        </span>
      </div>
      {children.length === 0 ? null : (
        <ul className="mt-0.5 ml-[13px] flex flex-col gap-0.5 border-l border-line-soft pl-1.5">
          {children.map((child) => (
            <SubagentRow key={child.id} sub={child} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Renders the Subagents surface: every subagent of the session, each under
 * the one that started it, and a footer with what still runs and the tokens
 * spent.
 */
function SubagentsSurface(): JSX.Element {
  const s = useProto();
  const subagents = listSubagents(s);
  const top = listChildren(subagents, null);
  const running = subagents.filter((sub) => sub.status === "running").length;
  const tokens = subagents.reduce((sum, sub) => sum + sub.tokens, 0);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-2 pb-4">
        <LaneLabel className="px-2">Started by the main agent · {top.length}</LaneLabel>
        <ul className="flex flex-col gap-0.5">
          {top.map((sub) => (
            <SubagentRow key={sub.id} sub={sub} />
          ))}
        </ul>
      </div>
      <div className="flex h-12 shrink-0 items-center gap-3 border-t border-line-soft px-4 text-meta text-muted">
        <span>
          {running > 0 ? `${String(running)} running · ` : ""}
          {subagents.length - running} settled
        </span>
        {running > 0 ? <StopPill label="Stop all" onStop={stopEverything} /> : null}
        <span className="ml-auto font-mono text-fine text-faint tabular-nums">
          Σ {formatTokens(tokens)} tok
        </span>
      </div>
    </div>
  );
}
