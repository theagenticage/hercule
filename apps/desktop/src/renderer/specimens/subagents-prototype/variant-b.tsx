/**
 * PROTOTYPE (#354), throwaway. Variant B, "Side panel": the subagents live in
 * a panel at the right of the thread, as an inspector. The panel lists them,
 * running first, and opens one's transcript in place, beside the parent's,
 * which stays in view. The thread's own transcript keeps only a chip where
 * the agent spawned them.
 */
import { useState, type JSX } from "react";
import { resolveBrowserTimezone, type ThreadBlock } from "@hercule/client-core";
import { buildLook, Face } from "../../faces";
import { Mark } from "../../marks";
import { CloseIcon } from "../../icons/close";
import { StopIcon } from "../../icons/stop";
import { ChevronRightIcon } from "../../icons/chevron-right";
import {
  AgentMessage,
  LiveRow,
  TurnEnding,
  UserMessage,
  WaitingNote,
  WorkDivider,
} from "../../screens/thread/blocks";
import { RequestDock } from "../../screens/thread/dock";
import type { PrototypeBlock } from "../../screens/thread/transcript";
import { THREAD_ID, type ProtoSubagent } from "./fixture";
import { Brief } from "./variant-a";
import {
  buildCustomBlock,
  buildSubagentBlocks,
  countDescendants,
  decideSubagentPose,
  describeSubagentState,
  hasOpenRequest,
  hueStyle,
  listAncestors,
  listChildren,
  listOpenRequests,
  listSubagents,
  measureSubagent,
  nameSubagent,
  PrototypeThread,
  RequestPager,
  spliceAtSpawn,
  StopButton,
  stopEverything,
  stopSubagent,
  SubagentFace,
  SubagentMark,
  SubagentName,
  update,
  useProto,
} from "./shared";

const openInPanel = (id: string | null): void => {
  update({ open: id, panel: true });
};

/** Renders the chip at the spawn point: the faces, what runs, and Show. */
function SpawnChip(): JSX.Element {
  const s = useProto();
  const subagents = listSubagents(s);
  const top = subagents.filter((sub) => sub.parentId === null);
  const running = subagents.filter((sub) => sub.status === "running").length;
  const waiting = subagents.filter((sub) => hasOpenRequest(s, sub.id)).length;
  return (
    <button type="button" className="proto-b-chip" onClick={() => openInPanel(null)}>
      <span className="proto-b-faces">
        {top.map((sub) => (
          <SubagentFace key={sub.id} sub={sub} size={20} waiting={hasOpenRequest(s, sub.id)} />
        ))}
      </span>
      <span>
        <b>{top.length} subagents</b>
        {running > 0 ? ` · ${String(running)} running` : " · all finished"}
        {waiting > 0 ? <span className="proto-you"> · {waiting} waiting on you</span> : null}
      </span>
      <span className="proto-b-show">
        Show <ChevronRightIcon size={12} />
      </span>
    </button>
  );
}

/** Renders the header pill that shows and hides the panel. */
function PanelToggle(): JSX.Element {
  const s = useProto();
  const subagents = listSubagents(s);
  const running = subagents.filter((sub) => sub.status === "running").length;
  return (
    <span className="pill">
      <button
        type="button"
        className={`ptab${s.panel ? " is-on" : ""}`}
        onClick={() => update({ panel: !s.panel })}
      >
        {running > 0 ? <Mark state="working" /> : null}
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

/** Renders one row of the panel's list. `context` names its parent, for a nested subagent. */
function PanelRow({
  sub,
  depth,
  context,
}: {
  readonly sub: ProtoSubagent;
  readonly depth: number;
  readonly context: string | null;
}): JSX.Element {
  const s = useProto();
  const waiting = hasOpenRequest(s, sub.id);
  const line =
    sub.status === "running"
      ? waiting
        ? "Waiting on you"
        : sub.activity
      : (context ?? sub.result);
  return (
    <div
      role="button"
      tabIndex={0}
      className="proto-b-row"
      style={{ ...hueStyle(sub.id), paddingLeft: 10 + depth * 18 }}
      onClick={() => openInPanel(sub.id)}
    >
      <SubagentFace sub={sub} size={24} waiting={waiting} />
      <span className="proto-b-text">
        <SubagentName sub={sub} />
        {line === null ? null : (
          <span className={`proto-b-line is-${waiting ? "waiting" : sub.status}`}>{line}</span>
        )}
      </span>
      <span className="proto-b-end">
        <SubagentMark sub={sub} waiting={waiting} />
        <span>{measureSubagent(sub)}</span>
      </span>
      {sub.status === "running" ? <StopButton id={sub.id} label="" /> : null}
    </div>
  );
}

/** Renders the running subagents as a tree: each under its running parent. */
function RunningTree({
  parentId,
  depth,
}: {
  readonly parentId: string | null;
  readonly depth: number;
}): JSX.Element {
  const s = useProto();
  const running = listSubagents(s).filter(
    (sub) => sub.status === "running" && sub.parentId === parentId,
  );
  return (
    <>
      {running.map((sub) => (
        <div key={sub.id}>
          <PanelRow sub={sub} depth={depth} context={null} />
          <RunningTree parentId={sub.id} depth={depth + 1} />
        </div>
      ))}
    </>
  );
}

function PanelList(): JSX.Element {
  const s = useProto();
  const subagents = listSubagents(s);
  const running = subagents.filter((sub) => sub.status === "running");
  const finished = subagents.filter((sub) => sub.status !== "running");
  return (
    <>
      <header className="proto-b-head">
        <b>Subagents</b>
        <span className="count">{subagents.length}</span>
        <span className="spacer" />
        {running.length > 0 ? (
          <button
            type="button"
            className="btn btn--quiet btn--sm proto-stop"
            onClick={stopEverything}
          >
            <StopIcon size={12} />
            Stop all
          </button>
        ) : null}
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Close"
          onClick={() => update({ panel: false })}
        >
          <CloseIcon size={14} />
        </button>
      </header>
      <div className="proto-b-scroll">
        {running.length > 0 ? (
          <section>
            <h4 className="proto-b-section">Running · {running.length}</h4>
            <RunningTree parentId={null} depth={0} />
          </section>
        ) : null}
        <section>
          <h4 className="proto-b-section">Finished · {finished.length}</h4>
          {finished.map((sub) => {
            const parent = subagents.find((each) => each.id === sub.parentId);
            return (
              <PanelRow
                key={sub.id}
                sub={sub}
                depth={0}
                context={parent === undefined ? null : `in ${nameSubagent(parent)}`}
              />
            );
          })}
        </section>
      </div>
    </>
  );
}

const timezone = resolveBrowserTimezone();
const today = new Date(2026, 8, 29).getTime();

/** Renders a subagent's transcript in the panel: every block in a plain column, without the virtualizer. */
function MiniTranscript({
  blocks,
  sub,
  waiting,
}: {
  readonly blocks: readonly (ThreadBlock | PrototypeBlock)[];
  readonly sub: ProtoSubagent;
  readonly waiting: boolean;
}): JSX.Element {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const pose = decideSubagentPose(sub, waiting);
  const agent = "Sonnet 5";
  return (
    <div className="proto-b-tx tx">
      {blocks.map((block) => (
        <div key={block.key} className="tx-item">
          {block.kind === "custom" ? (
            block.render()
          ) : block.kind === "user" ? (
            <UserMessage text={block.text} at={block.at} timezone={timezone} today={today} />
          ) : block.kind === "agent" ? (
            <AgentMessage
              sessionId={sub.id}
              itemId={block.itemId}
              agent={agent}
              text={block.text}
              startedAt={block.startedAt}
              timezone={timezone}
              today={today}
              pose={block.live ? pose : "idle"}
              open={false}
              attachOpenParagraph={() => undefined}
            />
          ) : block.kind === "live" ? (
            <LiveRow sessionId={sub.id} agent={agent} pose={pose} />
          ) : block.kind === "work" ? (
            <WorkDivider
              block={block}
              onScreen
              expanded={expanded.has(block.key)}
              onToggle={(key) => {
                const next = new Set(expanded);
                if (!next.delete(key)) next.add(key);
                setExpanded(next);
              }}
            />
          ) : block.kind === "ending" ? (
            <TurnEnding block={block} />
          ) : (
            <WaitingNote openedAt={block.openedAt} timezone={timezone} today={today} onScreen />
          )}
        </div>
      ))}
    </div>
  );
}

function PanelSubagent({ sub }: { readonly sub: ProtoSubagent }): JSX.Element {
  const s = useProto();
  const subagents = listSubagents(s);
  const parent = listAncestors(subagents, sub).at(-1);
  const waiting = hasOpenRequest(s, sub.id);
  const below = countDescendants(subagents, sub.id);
  const request = listOpenRequests(s).find((each) => each.subagentId === sub.id);
  const blocks = buildSubagentBlocks(
    s,
    sub,
    buildCustomBlock(`brief:${sub.id}`, 0, () => <Brief sub={sub} parent={parent} />),
    buildCustomBlock(`spawn:${sub.id}`, 0, () => (
      <div className="proto-b-children">
        {listChildren(subagents, sub.id).map((child) => (
          <PanelRow key={child.id} sub={child} depth={0} context={null} />
        ))}
      </div>
    )),
  );
  return (
    <>
      <header className="proto-b-head">
        <button
          type="button"
          className="btn btn--quiet btn--sm proto-b-back"
          onClick={() => update({ open: null })}
        >
          <span className="proto-flip">
            <ChevronRightIcon size={12} />
          </span>
          All subagents
        </button>
        <span className="spacer" />
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          aria-label="Close"
          onClick={() => update({ panel: false, open: null })}
        >
          <CloseIcon size={14} />
        </button>
      </header>
      <div className="proto-b-who" style={hueStyle(sub.id)}>
        <Face
          look={buildLook(sub.id)}
          pose={decideSubagentPose(sub, waiting)}
          size={34}
          animated={sub.status === "running" && !waiting}
        />
        <div className="proto-b-who-text">
          <SubagentName sub={sub} />
          <span>
            {describeSubagentState(sub, waiting)} · {(sub.tokens / 1000).toFixed(1)}k tokens
          </span>
          <span>
            Subagent of{" "}
            {parent === undefined ? (
              "the main agent"
            ) : (
              <button type="button" className="proto-link" onClick={() => openInPanel(parent.id)}>
                {nameSubagent(parent)}
              </button>
            )}
          </span>
        </div>
        {sub.status === "running" ? (
          <button
            type="button"
            className="btn btn--sm proto-stop"
            onClick={() => stopSubagent(sub.id)}
          >
            <StopIcon size={12} />
            {below > 0 ? `Stop with ${String(below)} below` : "Stop"}
          </button>
        ) : null}
      </div>
      <div className="proto-b-scroll" style={hueStyle(sub.id)}>
        <MiniTranscript blocks={blocks} sub={sub} waiting={waiting} />
      </div>
      {request === undefined ? null : (
        <div className="proto-b-dock">
          <RequestDock
            key={request.request.requestId}
            sessionId={THREAD_ID}
            request={request.request}
            faceSeed={sub.id}
          />
        </div>
      )}
    </>
  );
}

export function VariantBThread(): JSX.Element {
  const s = useProto();
  const sub = listSubagents(s).find((each) => each.id === s.open);
  return (
    <div className="proto-b-split">
      <div className="proto-b-main">
        <PrototypeThread
          hideSubagentItems={false}
          shapeBlocks={(blocks) =>
            spliceAtSpawn(
              blocks,
              buildCustomBlock("proto-spawn", 40, () => <SpawnChip />),
            )
          }
          headerExtra={<PanelToggle />}
          aboveDock={<RequestPager onOpen={openInPanel} />}
        />
      </div>
      {s.panel ? (
        <aside
          className={`proto-b-panel${sub === undefined ? "" : " is-wide"}`}
          aria-label="Subagents"
        >
          {sub === undefined ? <PanelList /> : <PanelSubagent key={sub.id} sub={sub} />}
        </aside>
      ) : null}
    </div>
  );
}
