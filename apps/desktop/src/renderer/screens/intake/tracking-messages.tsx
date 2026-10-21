/**
 * The parts of the Tracking pane's trip, as the Tracking drawing draws them:
 * what the user asked, what the agent did, and what waits on the user. Every
 * part takes values and callbacks and reads nothing; `TrackingTrip` reads the
 * data and works the values out (spec 17 §Tracking).
 */
import type { CSSProperties, JSX, ReactNode } from "react";
import type { TrackingOutput } from "@hercule/contract";
import { describeTrackingOutputValue } from "@hercule/client-core";
import { Mark, type MarkState } from "../../marks";
import { BoltIcon } from "../../icons/bolt";
import { Markdown } from "../session/markdown";
import "./tracking.css";

/** A string of a structured output longer than this is cut to two lines in its row. */
const LONG_VALUE_LENGTH = 60;

/** What the quote of the signal the user handed off shows. */
export type AskedQuote =
  | { readonly kind: "loading" }
  | { readonly kind: "failed"; readonly message: string }
  | {
      readonly kind: "ready";
      /** The mark of the signal's source. */
      readonly mark: ReactNode;
      /** Who asked, or the source when no one is named. */
      readonly who: string;
      /** The kind and the place of the signal, "review requested · payments-api #1294", or "" when it has neither. */
      readonly kindAndPlace: string;
      /** The signal's first block, drawn in two lines. */
      readonly text: ReactNode;
    };

/**
 * Renders the message of the user's handoff: their avatar, "You asked" with
 * `small` beside it, and the quote of the signal they handed off.
 */
export function AskedMessage({
  avatar,
  small,
  quote,
}: {
  readonly avatar: ReactNode;
  readonly small: string;
  readonly quote: AskedQuote;
}): JSX.Element {
  return (
    <div className="tr-msg tr-msg--you">
      <span className="tr-av">{avatar}</span>
      <div className="tr-msg-body">
        <div className="tr-name">
          You asked <small>{small}</small>
        </div>
        {quote.kind === "ready" && (
          <div className="tr-orig">
            <div className="tr-orig-h">
              <span className="tr-orig-src">{quote.mark}</span>
              <b>{quote.who}</b>
              {quote.kindAndPlace !== "" && <span>{`· ${quote.kindAndPlace}`}</span>}
            </div>
            <div className="tr-orig-q">{quote.text}</div>
          </div>
        )}
        {quote.kind === "failed" && (
          <p className="ad-flag" role="alert">
            {quote.message}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Renders the message of the agent: its face, its name in the colour of its
 * face with `stamp` beside it, and what `children` draw under the name.
 * `hue` paints the name.
 */
export function AgentMessage({
  face,
  name,
  hue,
  stamp,
  children,
}: {
  readonly face: ReactNode;
  readonly name: string;
  readonly hue: CSSProperties;
  readonly stamp: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="tr-msg tr-msg--did">
      <span className="tr-av">{face}</span>
      <div className="tr-msg-body">
        <div className="tr-name" style={hue}>
          {name} <small>{stamp}</small>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Renders why the run failed, ruled in the failure colour. */
export function FailureReason({ cause }: { readonly cause: string }): JSX.Element {
  return <p className="tr-text tr-fail">{cause}</p>;
}

/**
 * Renders what a run's last agent step put out, drawn by its shape: a step
 * with an output schema is its fields, ruled one row each, and a link to the
 * whole output in the run; a step without one is its final message as
 * markdown, and a link to its thread when it has one.
 */
export function StepOutput({
  output,
  onOpenRun,
  onOpenThread,
}: {
  readonly output: TrackingOutput;
  readonly onOpenRun: () => void;
  readonly onOpenThread: (sessionId: string) => void;
}): JSX.Element {
  return (
    <>
      <p className="tr-out-from">
        From the step <b>{output.stepName}</b>
      </p>
      {output.kind === "fields" ? (
        <>
          <dl className="tr-out">
            {output.fields.map((field, index) => {
              const value = describeTrackingOutputValue(field.value);
              return (
                // Two fields can share a label, so the position is the key. The fields never reorder.
                <div key={index}>
                  <dt>{field.label}</dt>
                  <dd>
                    {value.muted ? (
                      <span className="tr-out-count">{value.text}</span>
                    ) : value.text.length > LONG_VALUE_LENGTH ? (
                      <span className="tr-out-long">{value.text}</span>
                    ) : (
                      value.text
                    )}
                  </dd>
                </div>
              );
            })}
          </dl>
          <button type="button" className="tr-more" onClick={onOpenRun}>
            See the whole output in the run
          </button>
        </>
      ) : (
        <>
          <div className="tr-text tr-did">
            <Markdown text={output.text} />
          </div>
          {output.sessionId !== undefined && (
            <button
              type="button"
              className="tr-more"
              onClick={() => {
                onOpenThread(output.sessionId!);
              }}
            >
              Read the rest in the thread
            </button>
          )}
        </>
      )}
    </>
  );
}

/** One run of the list of runs, with what it draws worked out. */
export interface RunLine {
  readonly runId: string;
  /** When the run ended, or when it started if it is live, as a time. Empty when it cannot be formatted. */
  readonly time: string;
  /** The ISO time `time` is of. */
  readonly timeAt: string;
  readonly mark: MarkState;
  readonly live: boolean;
  readonly workflowName: string;
  readonly hue: CSSProperties;
  /** How the run went: "finished", "failed: reason", "working". */
  readonly outcome: string;
  /** The session of the run's last agent step, when it has one. */
  readonly sessionId: string | undefined;
}

/**
 * Renders the runs of the Task, oldest first, one line each: the time, the
 * run's mark, the workflow's name, which opens the run, how the run went, and
 * a link to the run's thread when it has one.
 */
export function RunList({
  lines,
  onOpenRun,
  onOpenThread,
}: {
  readonly lines: ReadonlyArray<RunLine>;
  readonly onOpenRun: (runId: string) => void;
  readonly onOpenThread: (sessionId: string) => void;
}): JSX.Element {
  return (
    <ol className="tr-steps">
      {lines.map((line) => (
        <li key={line.runId} className={line.live ? "is-live" : undefined}>
          <time dateTime={line.timeAt}>{line.time}</time>
          <Mark state={line.mark} />
          <span className="tr-step-text">
            <span className="tr-step-line">
              <button
                type="button"
                className="tr-step-who"
                style={line.hue}
                onClick={() => {
                  onOpenRun(line.runId);
                }}
              >
                {line.workflowName}
              </button>
              {` ${line.outcome}`}
            </span>
            {line.sessionId !== undefined && (
              <button
                type="button"
                className="tr-step-thread"
                onClick={() => {
                  onOpenThread(line.sessionId!);
                }}
              >
                Thread
              </button>
            )}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** Renders the name of the action step the run ended on, after the agent. */
export function EndedOnAction({ stepName }: { readonly stepName: string }): JSX.Element {
  return (
    <p className="tr-out-action">
      <BoltIcon size={14} />
      <span>{stepName}</span>
    </p>
  );
}

/** Renders the question a run asks, in the waiting tint, with the way to its thread. */
export function QuestionCard({
  question,
  onOpenThread,
}: {
  readonly question: string;
  readonly onOpenThread: () => void;
}): JSX.Element {
  return (
    <div className="tr-ask">
      <p className="tr-ask-q">
        <Mark state="waiting" />
        <span>{question}</span>
      </p>
      <button type="button" className="btn btn--sm" onClick={onOpenThread}>
        Open the thread
      </button>
    </div>
  );
}

/**
 * Renders the message of the source of the signal that waits: its mark on a
 * disc, its name with `small` beside it, and a card with the signal's title
 * and the way to the signal.
 */
export function SignalMessage({
  mark,
  name,
  small,
  title,
  onOpenSignal,
}: {
  readonly mark: ReactNode;
  readonly name: string;
  readonly small: string;
  readonly title: string;
  readonly onOpenSignal: () => void;
}): JSX.Element {
  return (
    <div className="tr-msg tr-msg--src">
      <span className="tr-av">
        <span className="tr-src-av">{mark}</span>
      </span>
      <div className="tr-msg-body">
        <div className="tr-name">
          {name} <small>{small}</small>
        </div>
        <div className="tr-ask tr-ask--signal">
          <p className="tr-ask-q">
            <Mark state="waiting" />
            <span>{title}</span>
          </p>
          <button type="button" className="btn btn--sm" onClick={onOpenSignal}>
            Open the signal
          </button>
        </div>
      </div>
    </div>
  );
}
