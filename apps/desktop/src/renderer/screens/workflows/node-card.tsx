/**
 * PROTOTYPE. The card of details that opens over a node of the workflow
 * graph: where the drawn run is at the node, its facts, and a link to the
 * transcript of the session an agent step drives.
 */
import type { JSX, ReactNode } from "react";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { ThreadsIcon } from "../../icons/threads";
import { Mark } from "../../marks/mark";
import type { GraphNode } from "./graph-model";
import type { NodeDetails } from "./node-details";
import { NodeIcon } from "./node-icon";
import "../thread/menus.css";
import "./node-card.css";

/** Renders a row of the card that opens a session's transcript. */
function SessionLink({
  sessionId,
  onOpenSession,
  children,
}: {
  readonly sessionId: string;
  readonly onOpenSession: (sessionId: string) => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      className="line"
      onClick={() => {
        onOpenSession(sessionId);
      }}
    >
      {children}
      <ChevronRightIcon size={13} />
    </button>
  );
}

/**
 * Renders the inside of the card of `node`, from its `details`: the
 * header, then one section each for the status, the facts, the prompt, the
 * iterations and the link to the transcript, where the node has them.
 * `onOpenSession` opens a session's transcript.
 */
export function NodeCard({
  node,
  details,
  onOpenSession,
}: {
  readonly node: GraphNode;
  readonly details: NodeDetails;
  readonly onOpenSession: (sessionId: string) => void;
}): JSX.Element {
  const { status, question, facts, prompt, iterations, sessionId } = details;
  return (
    <>
      <div className="pop-h">
        <NodeIcon kind={node.kind} firesOnSchedule={node.firesOnSchedule} />
        <b>{details.id}</b>
        <span>{details.detail}</span>
      </div>
      {status === undefined ? null : (
        <div className="pop-sec">
          <div
            className={`line wfn-status${status.tone === undefined ? "" : ` is-${status.tone}`}`}
          >
            {status.mark === undefined ? (
              <span className="wfn-no-mark" />
            ) : (
              <Mark state={status.mark} />
            )}
            <span className="grow">
              <b>{status.text}</b>
              {question === undefined ? null : <small>{question}</small>}
            </span>
          </div>
        </div>
      )}
      {facts.length === 0 ? null : (
        <div className="pop-sec">
          <dl className="wfn-facts">
            {facts.map((fact) => (
              <div key={fact.label}>
                <dt>{fact.label}</dt>
                <dd
                  className={`${fact.isCode ? "is-code" : ""}${fact.tone === "fail" ? " is-fail" : ""}`}
                  title={fact.value}
                >
                  {fact.value}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
      {prompt === undefined ? null : (
        <div className="pop-sec">
          <div className="q-h">Prompt</div>
          <p className="wfn-prompt">{prompt}</p>
        </div>
      )}
      {iterations.length === 0 ? null : (
        <div className="pop-sec">
          <div className="q-h">{`Ran ${String(iterations.length)} times`}</div>
          {iterations.map((iteration) => {
            const row = (
              <>
                <Mark state={iteration.mark} />
                <span className="grow">
                  <b>{`#${String(iteration.number)}`}</b> {iteration.text}
                </span>
                <span className="line-note">{iteration.durationText}</span>
              </>
            );
            return iteration.sessionId === undefined ? (
              <div key={iteration.number} className="line">
                {row}
              </div>
            ) : (
              <SessionLink
                key={iteration.number}
                sessionId={iteration.sessionId}
                onOpenSession={onOpenSession}
              >
                {row}
              </SessionLink>
            );
          })}
        </div>
      )}
      {sessionId === undefined ? null : (
        <div className="pop-sec">
          <SessionLink sessionId={sessionId} onOpenSession={onOpenSession}>
            <ThreadsIcon size={14} />
            <span className="grow">
              <b>Open transcript</b>
            </span>
          </SessionLink>
        </div>
      )}
    </>
  );
}
