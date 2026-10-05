/**
 * PROTOTYPE (#354), throwaway. Variant D, "Side pane", round 1.5: the thread
 * splits into the main pane and a side pane the user resizes by dragging.
 * The side pane hosts surfaces in tabs (browser, terminal, files, diff, pull
 * request, subagents), so the Subagents surface is one of many, not chrome of
 * its own. Only the Subagents surface is drawn; the rest are stubs.
 *
 * The transcript keeps one line per subagent where it was started. A tally
 * pill, placed by a knob, opens the Subagents surface. A subagent opens in the
 * main pane, drawn as loudly as the page knob says, in the hue the hue knob
 * says; the side pane stays open beside it.
 */
import type { JSX, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Mark } from "../../marks";
import { BranchIcon } from "../../icons/branch";
import { CloseIcon } from "../../icons/close";
import { CrewIcon } from "../../icons/crew";
import { ExternalIcon } from "../../icons/external";
import { FileIcon } from "../../icons/file";
import { ListIcon } from "../../icons/list";
import { PlusIcon } from "../../icons/plus";
import { SidebarIcon } from "../../icons/sidebar";
import { StopIcon } from "../../icons/stop";
import { SystemIcon } from "../../icons/system";
import type { ProtoSubagent } from "./fixture";
import { SubagentPage } from "./variant-a";
import { SpawnLinks } from "./variant-c";
import {
  buildCustomBlock,
  hasOpenRequest,
  hueStyle,
  listChildren,
  listOpenRequests,
  listSubagents,
  measureSubagent,
  PrototypeThread,
  RequestPager,
  spliceAtSpawn,
  StopButton,
  stopEverything,
  SubagentFace,
  SubagentMark,
  SubagentName,
  type SurfaceKind,
  update,
  useProto,
} from "./shared";

const open = (id: string | null): void => {
  update({ open: id });
};

const SURFACES: readonly {
  readonly kind: SurfaceKind;
  readonly name: string;
  readonly key: string;
  readonly icon: ReactNode;
}[] = [
  { kind: "browser", name: "Browser", key: "B", icon: <ExternalIcon size={14} /> },
  { kind: "terminal", name: "Terminal", key: "T", icon: <SystemIcon size={14} /> },
  { kind: "files", name: "Files", key: "F", icon: <FileIcon size={14} /> },
  { kind: "diff", name: "Diff", key: "D", icon: <ListIcon size={14} /> },
  { kind: "pull-request", name: "Pull request", key: "P", icon: <BranchIcon size={14} /> },
  { kind: "subagents", name: "Subagents", key: "S", icon: <CrewIcon size={14} /> },
];

const findSurface = (kind: SurfaceKind): (typeof SURFACES)[number] =>
  SURFACES.find((each) => each.kind === kind)!;

/** Shows `kind` in the side pane: opens the pane, adds the tab if it is missing, and selects it. */
const showSurface = (kind: SurfaceKind, surfaces: readonly SurfaceKind[]): void => {
  update({
    pane: true,
    picker: false,
    surface: kind,
    surfaces: surfaces.includes(kind) ? surfaces : [...surfaces, kind],
  });
};

// ------------------------------------------------------------ the side pane

const MIN_PANE = 300;
const MIN_MAIN = 520;

/** Renders the strip on the pane's left edge that resizes it by dragging. */
function ResizeHandle(): JSX.Element {
  const start = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const handle = event.currentTarget;
    const right = handle.parentElement!.getBoundingClientRect().right;
    const main = handle.closest(".proto-split")!.getBoundingClientRect();
    handle.setPointerCapture(event.pointerId);
    const move = (moved: PointerEvent): void => {
      const max = main.width - MIN_MAIN;
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
      className="proto-pane-handle"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the side pane"
      onPointerDown={start}
    />
  );
}

/** Renders the "+" menu that opens a surface; a surface's letter opens it too. */
function SurfacePicker({ surfaces }: { readonly surfaces: readonly SurfaceKind[] }): JSX.Element {
  return (
    <div
      className="proto-picker"
      role="menu"
      aria-label="Open a surface"
      tabIndex={-1}
      ref={(menu) => menu?.focus()}
      onKeyDown={(event) => {
        if (event.key === "Escape") update({ picker: false });
        const chosen = SURFACES.find((each) => each.key === event.key.toUpperCase());
        if (chosen !== undefined) showSurface(chosen.kind, surfaces);
      }}
    >
      <h4>Open a surface</h4>
      {SURFACES.map((each) => (
        <button
          key={each.kind}
          type="button"
          role="menuitem"
          onClick={() => showSurface(each.kind, surfaces)}
        >
          {each.icon}
          <span>{each.name}</span>
          <kbd>{each.key}</kbd>
        </button>
      ))}
    </div>
  );
}

/** Renders the side pane: the tabs of its surfaces, "+" to open another, and the shown surface. */
function SidePane(): JSX.Element {
  const s = useProto();
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
      className={`proto-pane is-${s.paneTone}`}
      style={{ width: s.paneWidth }}
      aria-label="Side pane"
    >
      <ResizeHandle />
      <header className="proto-pane-head">
        <div className="proto-tabs" role="tablist">
          {s.surfaces.map((kind) => {
            const surface = findSurface(kind);
            return (
              <span key={kind} className={`proto-tab${s.surface === kind ? " is-on" : ""}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={s.surface === kind}
                  onClick={() => update({ surface: kind })}
                >
                  {surface.icon}
                  {surface.name}
                </button>
                <button
                  type="button"
                  className="proto-tab-close"
                  aria-label={`Close ${surface.name}`}
                  onClick={() => close(kind)}
                >
                  <CloseIcon size={12} />
                </button>
              </span>
            );
          })}
          <span className="proto-picker-wrap">
            <button
              type="button"
              className={`icon-btn icon-btn--sm${s.picker ? " is-on" : ""}`}
              aria-label="Open a surface"
              aria-expanded={s.picker}
              onClick={() => update({ picker: !s.picker })}
            >
              <PlusIcon size={14} />
            </button>
            {s.picker ? <SurfacePicker surfaces={s.surfaces} /> : null}
          </span>
        </div>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Close the side pane"
          onClick={() => update({ pane: false, picker: false })}
        >
          <CloseIcon size={14} />
        </button>
      </header>
      {s.surface === "subagents" && s.surfaces.includes("subagents") ? (
        <SubagentsSurface />
      ) : (
        <div className="proto-stub">
          {findSurface(s.surface).icon}
          <b>{findSurface(s.surface).name}</b>
          <span>Not part of this prototype.</span>
        </div>
      )}
    </aside>
  );
}

/** Renders the header's toggle for the side pane, at the window's right edge. */
function PaneToggle(): JSX.Element {
  const s = useProto();
  return (
    <span className="pill">
      <button
        type="button"
        className={`icon-btn${s.pane ? " is-on" : ""}`}
        aria-label={s.pane ? "Hide the side pane" : "Show the side pane"}
        aria-pressed={s.pane}
        onClick={() => update({ pane: !s.pane, picker: false })}
      >
        <span className="proto-flip">
          <SidebarIcon />
        </span>
      </button>
    </span>
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
      "kind" in row.event &&
      row.event._tag === "item.started" &&
      TOOL_KINDS.has(String(row.event.kind)),
  ).length;

/** Places the rail that ties nested rows to their parent under the parent's face. */
const railStyle = (depth: number): Record<string, string> => ({
  "--rail-x": `${String(20 + depth * 20)}px`,
});

const formatTokens = (tokens: number): string => `${(tokens / 1000).toFixed(1)}k tok`;

/** Renders one subagent of the surface, and below it the subagents it started. */
function SubagentRow({
  sub,
  depth,
}: {
  readonly sub: ProtoSubagent;
  readonly depth: number;
}): JSX.Element {
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
        className={`proto-sub-row${s.open === sub.id ? " is-on" : ""}`}
        style={{ ...hueStyle(sub.id, s), paddingLeft: 10 + depth * 20 }}
        onClick={() => open(sub.id)}
      >
        <SubagentFace sub={sub} size={22} waiting={waiting} />
        <span className="proto-sub-body">
          <span className="proto-sub-top">
            <SubagentName sub={sub} />
            <code className="proto-sub-type">{sub.agentType}</code>
            <span className="proto-sub-end">
              {sub.status === "stopped" ? <span>stopped ·</span> : null}
              <span>{measureSubagent(sub)}</span>
              <SubagentMark sub={sub} waiting={waiting} />
            </span>
          </span>
          {line === null ? null : (
            <span className={`proto-sub-line is-${waiting ? "waiting" : sub.status}`}>{line}</span>
          )}
          <span className="proto-sub-meta">
            sonnet-5 · {formatTokens(sub.tokens)} · {countTools(sub)} tools
          </span>
        </span>
        {sub.status === "running" ? <StopButton id={sub.id} /> : null}
      </div>
      {children.length === 0 ? null : (
        <ul className="proto-sub-tree is-nested" style={railStyle(depth)}>
          {children.map((child) => (
            <SubagentRow key={child.id} sub={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Renders the Subagents surface: every subagent of the session, each under
 * the one that started it, and a footer with what still runs and the tokens
 * spent. The meta line has no effort level: the subagent record (decided in
 * "What a subagent is in the contract") does not carry one.
 */
function SubagentsSurface(): JSX.Element {
  const s = useProto();
  const subagents = listSubagents(s);
  const top = listChildren(subagents, null);
  const running = subagents.filter((sub) => sub.status === "running").length;
  const tokens = subagents.reduce((sum, sub) => sum + sub.tokens, 0);
  return (
    <div className="proto-surface">
      <div className="proto-surface-scroll">
        <h4 className="proto-surface-section">Started by the main agent · {top.length}</h4>
        <ul className="proto-sub-tree">
          {top.map((sub) => (
            <SubagentRow key={sub.id} sub={sub} depth={0} />
          ))}
        </ul>
      </div>
      <footer className="proto-surface-foot">
        <span>
          {running > 0 ? `${String(running)} running · ` : ""}
          {subagents.length - running} settled
        </span>
        {running > 0 ? (
          <button
            type="button"
            className="btn btn--quiet btn--sm proto-stop"
            onClick={stopEverything}
          >
            <StopIcon size={12} />
            Stop all
          </button>
        ) : null}
        <span className="spacer" />
        <span>Σ {formatTokens(tokens)}</span>
      </footer>
    </div>
  );
}

// ------------------------------------------------------------ the tally

/** Renders the tally pill: what runs, and a way into the Subagents surface. A second click hides it. */
function TallyPill({ at }: { readonly at: "header" | "composer" }): JSX.Element | null {
  const s = useProto();
  const subagents = listSubagents(s);
  if (subagents.length === 0) return null;
  const running = subagents.filter((sub) => sub.status === "running").length;
  const waiting = listOpenRequests(s).some((request) => request.subagentId !== null);
  const shown = s.pane && s.surface === "subagents" && s.surfaces.includes("subagents");
  return (
    <span className={`pill proto-tally is-${at}`}>
      <button
        type="button"
        className={`ptab${shown ? " is-on" : ""}`}
        aria-pressed={shown}
        onClick={() =>
          shown ? update({ pane: false, picker: false }) : showSurface("subagents", s.surfaces)
        }
      >
        {running > 0 ? <Mark state={waiting ? "waiting" : "working"} /> : <CrewIcon size={14} />}
        <span>Subagents</span>
        <small>
          {running > 0
            ? `${String(running)} of ${String(subagents.length)} running`
            : String(subagents.length)}
        </small>
      </button>
    </span>
  );
}

// ------------------------------------------------------------ the screen

export function VariantDThread(): JSX.Element {
  const s = useProto();
  const sub = listSubagents(s).find((each) => each.id === s.open);
  const header = (
    <>
      {s.tally === "header" ? <TallyPill at="header" /> : null}
      <PaneToggle />
    </>
  );
  const aboveComposer = s.tally === "composer" ? <TallyPill at="composer" /> : null;
  return (
    <div className="proto-split">
      <div className="proto-split-main">
        {sub === undefined ? (
          <PrototypeThread
            hideSubagentItems
            shapeBlocks={(blocks) =>
              spliceAtSpawn(
                blocks,
                buildCustomBlock("proto-spawn", 130, () => <SpawnLinks parentId={null} />),
              )
            }
            headerExtra={header}
            aboveDock={
              <>
                {aboveComposer}
                <RequestPager onOpen={open} />
              </>
            }
          />
        ) : (
          <SubagentPage
            key={sub.id}
            sub={sub}
            takeover={s.takeover}
            spawn={(id) => <SpawnLinks parentId={id} />}
            headerExtra={header}
            aboveStatus={aboveComposer}
          />
        )}
      </div>
      {s.pane ? <SidePane /> : null}
    </div>
  );
}
