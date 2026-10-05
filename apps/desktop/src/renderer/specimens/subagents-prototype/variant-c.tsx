/**
 * PROTOTYPE (#354), throwaway. Variant C, "Sidebar nest": the subagents live
 * in the app's sidebar, nested under their thread like files under a folder,
 * so every thread's subagents are one glance away from any screen. The spawn
 * point keeps one link per subagent. A subagent opens as a page of its own,
 * tinted in its hue so it can never pass for a thread.
 */
import type { JSX } from "react";
import { Mark } from "../../marks";
import { StopIcon } from "../../icons/stop";
import { prototypeSidebar } from "../../shell/sidebar-list";
import type { ProtoSubagent } from "./fixture";
import { THREAD_ID } from "./fixture";
import { SubagentPage } from "./variant-a";
import {
  buildCustomBlock,
  countDescendants,
  describeSubagentState,
  hasOpenRequest,
  hueStyle,
  listChildren,
  listSubagents,
  PrototypeThread,
  RequestPager,
  spliceAtSpawn,
  stopEverything,
  SubagentFace,
  SubagentMark,
  SubagentName,
  update,
  useProto,
  VARIANT,
} from "./shared";

const open = (id: string | null): void => {
  update({ open: id });
};

/** Renders one subagent's row in the sidebar, and its own subagents below it. */
function SideRow({
  sub,
  depth,
}: {
  readonly sub: ProtoSubagent;
  readonly depth: number;
}): JSX.Element {
  const s = useProto();
  const subagents = listSubagents(s);
  const waiting = hasOpenRequest(s, sub.id);
  return (
    <>
      <button
        type="button"
        className={`side-row proto-c-row${s.open === sub.id ? " is-on" : ""}${sub.status === "running" ? "" : " is-finished"}`}
        style={{ ...hueStyle(sub.id), paddingLeft: 18 + depth * 14 }}
        onClick={() => open(sub.id)}
        title={describeSubagentState(sub, waiting)}
      >
        <SubagentFace sub={sub} size={18} waiting={waiting} />
        <span className="side-name">
          <SubagentName sub={sub} />
        </span>
        <span className="side-end">
          {sub.status === "stopped" ? "stopped" : <SubagentMark sub={sub} waiting={waiting} />}
        </span>
      </button>
      {listChildren(subagents, sub.id).map((child) => (
        <SideRow key={child.id} sub={child} depth={depth + 1} />
      ))}
    </>
  );
}

/** Renders the thread's subagents under its sidebar row. */
function SidebarNest(): JSX.Element {
  const s = useProto();
  return (
    <div className="proto-c-nest">
      {listChildren(listSubagents(s), null).map((sub) => (
        <SideRow key={sub.id} sub={sub} depth={0} />
      ))}
    </div>
  );
}

if (VARIANT === "C")
  prototypeSidebar.renderAfterThread = (sessionId) =>
    sessionId === THREAD_ID ? <SidebarNest /> : null;

/** Renders the spawn point: one link per subagent `parentId` started here. `null` is the main agent. */
export function SpawnLinks({ parentId }: { readonly parentId: string | null }): JSX.Element {
  const s = useProto();
  const subagents = listSubagents(s);
  return (
    <ul className="proto-c-links" aria-label="Subagents started here">
      {listChildren(subagents, parentId).map((sub) => {
        const waiting =
          hasOpenRequest(s, sub.id) ||
          listChildren(subagents, sub.id).some((child) => hasOpenRequest(s, child.id));
        const below = countDescendants(subagents, sub.id);
        return (
          <li key={sub.id}>
            <button
              type="button"
              className="proto-c-link"
              style={hueStyle(sub.id)}
              onClick={() => open(sub.id)}
            >
              <span className="proto-c-arrow">↳</span>
              <SubagentFace sub={sub} size={18} waiting={hasOpenRequest(s, sub.id)} />
              <SubagentName sub={sub} />
              <span className="proto-c-state">
                {describeSubagentState(sub, false)}
                {below > 0 ? ` · ${String(below)} below` : ""}
                {waiting ? <span className="proto-you"> · waiting on you</span> : null}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Renders the header pill that says what still runs, and stops it all. */
function RunningPill(): JSX.Element | null {
  const s = useProto();
  const running = listSubagents(s).filter((sub) => sub.status === "running");
  if (running.length === 0) return null;
  return (
    <span className="pill proto-c-running">
      <span className="proto-c-running-text">
        <Mark state="working" />
        {running.length} subagents running
      </span>
      <button type="button" className="btn btn--quiet btn--sm proto-stop" onClick={stopEverything}>
        <StopIcon size={12} />
        Stop all
      </button>
    </span>
  );
}

export function VariantCThread(): JSX.Element {
  const s = useProto();
  const sub = listSubagents(s).find((each) => each.id === s.open);
  if (sub !== undefined)
    return (
      <SubagentPage sub={sub} takeover="gradient" spawn={(id) => <SpawnLinks parentId={id} />} />
    );
  return (
    <PrototypeThread
      hideSubagentItems
      shapeBlocks={(blocks) =>
        spliceAtSpawn(
          blocks,
          buildCustomBlock("proto-spawn", 130, () => <SpawnLinks parentId={null} />),
        )
      }
      headerExtra={<RunningPill />}
      aboveDock={<RequestPager onOpen={open} />}
    />
  );
}
