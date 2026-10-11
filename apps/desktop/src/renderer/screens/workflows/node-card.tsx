/**
 * The inside of a node's card on the workflow graph: the node's id and kind,
 * one label and value row per field its definition sets, and an agent step's
 * prompt (spec 17 §Workflows, "A step's card"). On a run's page the card is
 * led by where the run is at the node, and ends with each time the run came
 * to it and the thread it opens (spec 17 §Workflows, "A node's card on a
 * run").
 */
import type { JSX, ReactNode } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import type { NodeCard, NodeFact, NodeRunPart, NodeVisit } from "@hercule/client-core/node-details";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { ThreadsIcon } from "../../icons/threads";
import { Mark } from "../../marks";
import { useListTime, useStartTime } from "./list-time";
import { NodeIcon } from "./node-icon";
import { decideNodeRunTone, findNodeRunMark } from "./node-run-mark";
import { useStepDuration } from "./step-duration";
import "../thread/menus.css";
import "./node-card.css";

/** Renders the value of a time row, such as "Fri 14:00", kept current by the age clock. */
function TimeValue({
  fact,
  timezone,
}: {
  readonly fact: Extract<NodeFact, { kind: "time" }>;
  readonly timezone: string;
}): JSX.Element {
  // The card is drawn only while it is open, so it is always on screen.
  const text = useListTime(fact.at, timezone, fact.direction, true);
  return <dd>{text}</dd>;
}

/** Renders the value of a start time row, such as "Today 09:12", kept current by the age clock. */
function StartTimeValue({
  fact,
  timezone,
}: {
  readonly fact: Extract<NodeFact, { kind: "startTime" }>;
  readonly timezone: string;
}): JSX.Element {
  return <dd>{useStartTime(fact.at, timezone)}</dd>;
}

/** Renders the value of an elapsed row, such as "5m 0s", which counts up while the step runs. */
function ElapsedValue({
  fact,
}: {
  readonly fact: Extract<NodeFact, { kind: "elapsed" }>;
}): JSX.Element {
  return <dd>{useStepDuration(fact.startedAt, fact.finishedAt)}</dd>;
}

/** Renders the value of a row of text, in mono when it is code and in fail ink when it is an error. */
function TextValue({ fact }: { readonly fact: Extract<NodeFact, { kind: "text" }> }): JSX.Element {
  const className = [fact.isCode ? "is-code" : "", fact.isError ? "is-fail" : ""]
    .filter((name) => name !== "")
    .join(" ");
  return (
    <dd className={className === "" ? undefined : className} title={fact.value}>
      {fact.value}
    </dd>
  );
}

/** Renders the mark of a node in `state`, or, for a state with none, the room of one. */
function NodeRunMark({ state }: { readonly state: NodeRunPart["state"] }): JSX.Element {
  const mark = findNodeRunMark(state);
  return mark === undefined ? <span className="no-mark" /> : <Mark state={mark} />;
}

/**
 * Renders a row of the card that leads to a thread: a button that calls
 * `onOpen` and ends with a chevron when there is a session to open,
 * otherwise a plain row that opens nothing.
 */
function ThreadLine({
  onOpen,
  children,
}: {
  readonly onOpen: (() => void) | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  return onOpen === undefined ? (
    <div className="line">{children}</div>
  ) : (
    <button type="button" className="line" onClick={onOpen}>
      {children}
      <ChevronRightIcon size={13} />
    </button>
  );
}

/** Renders one time the run came to the step: its mark, its number and state, and how long it took. */
function VisitLine({
  visit,
  onOpen,
}: {
  readonly visit: NodeVisit;
  readonly onOpen: (() => void) | undefined;
}): JSX.Element {
  return (
    <ThreadLine onOpen={onOpen}>
      <NodeRunMark state={visit.state} />
      <span className="grow">
        <b>{`#${String(visit.number)}`}</b> {visit.text}
      </span>
      {visit.startedAt === undefined ? null : (
        <VisitDuration startedAt={visit.startedAt} finishedAt={visit.finishedAt} />
      )}
    </ThreadLine>
  );
}

/** Renders how long a visit took, or has run so far, at the right of its row. */
function VisitDuration({
  startedAt,
  finishedAt,
}: {
  readonly startedAt: string;
  readonly finishedAt: string | undefined;
}): JSX.Element {
  return <span className="line-note">{useStepDuration(startedAt, finishedAt)}</span>;
}

/**
 * Renders the inside of `card`: the header with the node's icon, its id and
 * its kind, then its rows and its prompt where it has them. Time rows are
 * shown in `timezone`. `pluginId` is the plugin whose action an action step
 * calls, or null, and its mark is drawn from `plugins`, as on the node.
 *
 * On a run's page, where `card.run` is set, the card also shows:
 *
 * - under the header, the node's mark and where the run is at the node,
 *   with what the step asks the user under it while it waits on them;
 * - after the prompt, "Ran 2 times" with a row per time the run came to the
 *   step, for a step it came to more than once;
 * - last, Open thread.
 *
 * A visit's row and Open thread call `onOpenSession` with the session they
 * open. Without `onOpenSession`, nothing opens a thread, and a visit with no
 * session, such as one waiting to start, is a plain row.
 */
export function NodeCardContent({
  card,
  pluginId,
  plugins,
  timezone,
  onOpenSession,
}: {
  readonly card: NodeCard;
  readonly pluginId: string | null;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly timezone: string;
  readonly onOpenSession?: ((sessionId: string) => void) | undefined;
}): JSX.Element {
  const { run } = card;
  const openSession = (sessionId: string | undefined): (() => void) | undefined =>
    sessionId === undefined || onOpenSession === undefined
      ? undefined
      : () => {
          onOpenSession(sessionId);
        };
  const tone = run === null ? undefined : decideNodeRunTone(run.state);
  return (
    <>
      <div className="pop-h">
        <NodeIcon kind={card.kind} firesOn={card.firesOn} pluginId={pluginId} plugins={plugins} />
        <b>{card.id}</b>
        <span>{card.kindText}</span>
      </div>
      {run === null ? null : (
        <div className="pop-sec">
          <div className={`line node-status${tone === undefined ? "" : ` is-${tone}`}`}>
            <NodeRunMark state={run.state} />
            <span className="grow">
              <b>{run.statusText}</b>
              {run.question === undefined ? null : <small>{run.question}</small>}
            </span>
          </div>
        </div>
      )}
      {card.facts.length === 0 ? null : (
        <div className="pop-sec">
          <dl className="node-facts">
            {card.facts.map((fact, index) => (
              // Two rows can share a label, such as two parameters' names; the order is fixed.
              <div key={`${String(index)} ${fact.label}`}>
                <dt>{fact.label}</dt>
                {fact.kind === "time" ? (
                  <TimeValue fact={fact} timezone={timezone} />
                ) : fact.kind === "startTime" ? (
                  <StartTimeValue fact={fact} timezone={timezone} />
                ) : fact.kind === "elapsed" ? (
                  <ElapsedValue fact={fact} />
                ) : (
                  <TextValue fact={fact} />
                )}
              </div>
            ))}
          </dl>
        </div>
      )}
      {card.prompt === undefined ? null : (
        <div className="pop-sec">
          <div className="q-h">Prompt</div>
          <p className="node-prompt">{card.prompt}</p>
        </div>
      )}
      {run === null || run.visits.length === 0 ? null : (
        <div className="pop-sec">
          <div className="q-h">{`Ran ${String(run.visits.length)} times`}</div>
          {run.visits.map((visit) => (
            <VisitLine key={visit.number} visit={visit} onOpen={openSession(visit.sessionId)} />
          ))}
        </div>
      )}
      {run?.sessionId === undefined || onOpenSession === undefined ? null : (
        <div className="pop-sec">
          <ThreadLine onOpen={openSession(run.sessionId)}>
            <ThreadsIcon size={14} />
            <span className="grow">
              <b>Open thread</b>
            </span>
          </ThreadLine>
        </div>
      )}
    </>
  );
}
