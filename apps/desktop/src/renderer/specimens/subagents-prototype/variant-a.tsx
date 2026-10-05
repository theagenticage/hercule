/**
 * PROTOTYPE (#354), throwaway. Variant A, "Inline tree": the subagents live
 * where the agent spawned them. The spawn point is a tree of rows that keep
 * finished subagents and nest grandchildren; a header chip opens the same
 * tree from anywhere; a chip above the composer stops what still runs. A
 * subagent opens as a page of its own, with a breadcrumb back to its parent.
 */
import { useState, type JSX, type ReactNode } from "react";
import { buildLook, Face } from "../../faces";
import { Mark } from "../../marks";
import { StopIcon } from "../../icons/stop";
import type { ProtoSubagent } from "./fixture";
import { THREAD_ID } from "./fixture";
import {
  buildCustomBlock,
  countDescendants,
  describeSubagentState,
  hasOpenRequest,
  hueStyle,
  listAncestors,
  listChildren,
  listDescendants,
  listSubagents,
  measureSubagent,
  nameSubagent,
  PrototypeThread,
  RequestPager,
  SCENARIO,
  spliceAtSpawn,
  StopButton,
  stopEverything,
  stopSubagent,
  SubagentFace,
  SubagentMark,
  SubagentName,
  SubagentTranscript,
  type Takeover,
  update,
  useProto,
} from "./shared";

const open = (id: string | null): void => {
  update({ open: id, popover: false });
};

/** Renders one subagent of the tree and, below it, its own subagents. */
function TreeRow({
  sub,
  depth,
  compact,
}: {
  readonly sub: ProtoSubagent;
  readonly depth: number;
  readonly compact: boolean;
}): JSX.Element {
  const s = useProto();
  const subagents = listSubagents(s);
  const waiting = hasOpenRequest(s, sub.id);
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
        className={`proto-a-row${compact ? " is-compact" : ""}`}
        style={{ ...hueStyle(sub.id), paddingLeft: 8 + depth * 22 }}
        onClick={() => open(sub.id)}
      >
        {depth > 0 ? <span className="proto-a-elbow" aria-hidden="true" /> : null}
        <SubagentFace sub={sub} size={compact ? 20 : 24} waiting={waiting} />
        <span className="proto-a-text">
          <SubagentName sub={sub} />
          {compact || line === null ? null : (
            <span className={`proto-a-line is-${waiting ? "waiting" : sub.status}`}>{line}</span>
          )}
        </span>
        <span className="proto-a-end">
          <SubagentMark sub={sub} waiting={waiting} />
          <span>{describeSubagentState(sub, waiting)}</span>
        </span>
        {sub.status === "running" ? <StopButton id={sub.id} /> : null}
      </div>
      {listChildren(subagents, sub.id).length === 0 ? null : (
        <ul className="proto-a-tree">
          {listChildren(subagents, sub.id).map((child) => (
            <TreeRow key={child.id} sub={child} depth={depth + 1} compact={compact} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Summarizes a set of subagents: "1 running · 1 failed · 1 stopped". */
const summarize = (subs: readonly ProtoSubagent[]): string => {
  const count = (status: ProtoSubagent["status"]): number =>
    subs.filter((sub) => sub.status === status).length;
  return [
    count("running") > 0 ? `${String(count("running"))} running` : null,
    count("completed") > 0 ? `${String(count("completed"))} done` : null,
    count("failed") > 0 ? `${String(count("failed"))} failed` : null,
    count("stopped") > 0 ? `${String(count("stopped"))} stopped` : null,
  ]
    .filter((each) => each !== null)
    .join(" · ");
};

/** Renders the spawn point: the subagents `parentId` started here, and theirs. `null` is the main agent. */
function SpawnGroup({ parentId }: { readonly parentId: string | null }): JSX.Element {
  const s = useProto();
  const subagents = listSubagents(s);
  const top = listChildren(subagents, parentId);
  return (
    <section className="proto-a-group" aria-label="Subagents">
      <header className="proto-a-group-head">
        <b>Started {top.length} subagents</b>
        <span>{summarize(listDescendants(subagents, parentId))}</span>
      </header>
      <ul className="proto-a-tree">
        {top.map((sub) => (
          <TreeRow key={sub.id} sub={sub} depth={0} compact={false} />
        ))}
      </ul>
    </section>
  );
}

/** Renders the header's chip, "2 running · 5 subagents", and the tree it opens. */
function HeaderChip(): JSX.Element {
  const s = useProto();
  const subagents = listSubagents(s);
  const running = subagents.filter((sub) => sub.status === "running");
  const waiting = running.some((sub) => hasOpenRequest(s, sub.id));
  return (
    <span className="pill proto-a-chip-wrap">
      <button
        type="button"
        className={`ptab${s.popover ? " is-on" : ""}`}
        aria-expanded={s.popover}
        onClick={() => update({ popover: !s.popover })}
      >
        {running.length > 0 ? <Mark state={waiting ? "waiting" : "working"} /> : null}
        <span>{running.length > 0 ? `${String(running.length)} running` : "Subagents"}</span>
        <small>
          {running.length > 0 ? `${String(subagents.length)} subagents` : subagents.length}
        </small>
      </button>
      {s.popover ? (
        <div className="proto-a-popover">
          <ul className="proto-a-tree">
            {listChildren(subagents, null).map((sub) => (
              <TreeRow key={sub.id} sub={sub} depth={0} compact />
            ))}
          </ul>
          {running.length > 0 ? (
            <footer>
              <span>{summarize(subagents)}</span>
              <button
                type="button"
                className="btn btn--quiet btn--sm proto-stop"
                onClick={stopEverything}
              >
                <StopIcon size={12} />
                Stop all
              </button>
            </footer>
          ) : null}
        </div>
      ) : null}
    </span>
  );
}

/** Renders the chip above the composer while subagents run: what runs, and Stop all. */
function RunningChip(): JSX.Element | null {
  const s = useProto();
  const running = listSubagents(s).filter((sub) => sub.status === "running");
  if (running.length === 0) return null;
  return (
    <div className="proto-a-running pill">
      <span className="proto-a-faces">
        {running.map((sub) => (
          <Face
            key={sub.id}
            look={buildLook(sub.id)}
            pose={hasOpenRequest(s, sub.id) ? "waiting" : "working"}
            size={18}
          />
        ))}
      </span>
      <span>
        {running.length} {running.length === 1 ? "subagent" : "subagents"} running
        {SCENARIO.state === "idle" && !s.sessionStopped ? " after the turn ended" : ""}
      </span>
      <button type="button" className="btn btn--quiet btn--sm proto-stop" onClick={stopEverything}>
        <StopIcon size={12} />
        Stop all
      </button>
    </div>
  );
}

export function VariantAThread(): JSX.Element {
  const s = useProto();
  const subagents = listSubagents(s);
  const sub = subagents.find((each) => each.id === s.open);
  if (sub !== undefined)
    return <SubagentPage sub={sub} takeover={null} spawn={(id) => <SpawnGroup parentId={id} />} />;
  return (
    <PrototypeThread
      hideSubagentItems
      shapeBlocks={(blocks) =>
        spliceAtSpawn(
          blocks,
          buildCustomBlock("proto-spawn", 330, () => <SpawnGroup parentId={null} />),
        )
      }
      headerExtra={<HeaderChip />}
      aboveDock={
        <>
          <RunningChip />
          <RequestPager onOpen={open} />
        </>
      }
    />
  );
}

/**
 * Renders a subagent as a page of its own: a breadcrumb from the thread down
 * to it, the brief its parent gave it, its transcript, and a status bar in
 * place of the composer. `spawn` draws the subagents it started, where it
 * started them. `takeover` says how loudly the page is drawn in the
 * subagent's hue, so it can never pass for a thread; `null` is not at all
 * (variant A). `headerExtra` is drawn at the header's end, and `aboveStatus`
 * on top of the status bar.
 */
export function SubagentPage({
  sub,
  takeover,
  spawn,
  headerExtra,
  aboveStatus,
}: {
  readonly sub: ProtoSubagent;
  readonly takeover: Takeover | null;
  readonly spawn: (parentId: string) => JSX.Element;
  readonly headerExtra?: ReactNode;
  readonly aboveStatus?: ReactNode;
}): JSX.Element {
  const s = useProto();
  const subagents = listSubagents(s);
  const ancestors = listAncestors(subagents, sub);
  const parent = ancestors.at(-1);
  const waiting = hasOpenRequest(s, sub.id);
  const below = countDescendants(subagents, sub.id);
  const parentName = parent === undefined ? "the main agent" : nameSubagent(parent);
  const brief = buildCustomBlock(`brief:${sub.id}`, 150, () => <Brief sub={sub} parent={parent} />);
  return (
    <div
      className={`proto-page${takeover === null ? "" : ` is-${takeover}`}`}
      style={hueStyle(sub.id, s)}
    >
      <header className="top">
        <nav className="pill proto-crumbs" aria-label="Subagent of">
          <button type="button" className="ptab" onClick={() => open(null)}>
            <span className="ptab-title">{SCENARIO.session.title}</span>
          </button>
          {ancestors.map((each) => (
            <span key={each.id} className="proto-crumb">
              <span className="proto-crumb-sep">›</span>
              <button type="button" className="ptab" onClick={() => open(each.id)}>
                <span className="ptab-title">{nameSubagent(each)}</span>
              </button>
            </span>
          ))}
          <span className="proto-crumb">
            <span className="proto-crumb-sep">›</span>
            <span className="ptab is-on proto-crumb-here">
              <SubagentMark sub={sub} waiting={waiting} />
              <span className="ptab-title">{nameSubagent(sub)}</span>
              {takeover === null ? null : <small className="proto-tag">subagent</small>}
            </span>
          </span>
        </nav>
        <span className="spacer" />
        {headerExtra}
      </header>
      <SubagentTranscript
        sub={sub}
        brief={brief}
        spawn={buildCustomBlock(`spawn:${sub.id}`, 140, () => spawn(sub.id))}
        bottom={
          <>
            {aboveStatus}
            <div className="composer-card proto-status">
              <SubagentFace sub={sub} size={26} waiting={waiting} />
              <span className="proto-status-text">
                <b className={`is-${waiting ? "waiting" : sub.status}`}>
                  {sub.status === "running"
                    ? waiting
                      ? "Waiting on you"
                      : `Working for ${measureSubagent(sub)}`
                    : sub.status === "completed"
                      ? `Done in ${measureSubagent(sub)}`
                      : sub.status === "failed"
                        ? `Failed after ${measureSubagent(sub)}`
                        : `Stopped after ${measureSubagent(sub)}`}
                </b>
                <span>
                  Subagent of {parentName} · {(sub.tokens / 1000).toFixed(1)}k tokens · takes no
                  messages
                </span>
              </span>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => open(parent?.id ?? null)}
              >
                Open parent
              </button>
              {sub.status === "running" ? (
                <button
                  type="button"
                  className="btn btn--sm proto-stop"
                  onClick={() => {
                    stopSubagent(sub.id);
                  }}
                  title={below > 0 ? `Also stops its ${String(below)} subagents` : undefined}
                >
                  <StopIcon size={12} />
                  {below > 0 ? `Stop with ${String(below)} below` : "Stop"}
                </button>
              ) : null}
            </div>
          </>
        }
      />
    </div>
  );
}

/** Renders the brief a subagent got from its parent, as the first block of its transcript. */
export function Brief({
  sub,
  parent,
}: {
  readonly sub: ProtoSubagent;
  readonly parent: ProtoSubagent | undefined;
}): JSX.Element {
  const [whole, setWhole] = useState(false);
  return (
    <div className="proto-brief">
      <div className="proto-brief-meta">
        <Face look={buildLook(parent?.id ?? THREAD_ID)} pose="idle" size={18} />
        <span>
          Brief from <b>{parent === undefined ? "the main agent" : nameSubagent(parent)}</b> ·{" "}
          {sub.agentType} agent
        </span>
      </div>
      <p
        className={`proto-brief-text${whole ? "" : " is-clamped"}`}
        onClick={() => setWhole(!whole)}
      >
        {sub.brief}
      </p>
    </div>
  );
}
