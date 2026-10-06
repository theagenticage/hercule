/**
 * PROTOTYPE (#448). The blocks of a Conversation: day stamps, Notices,
 * quiet lines, the user's bubbles and the assistant's messages with what
 * they carry.
 */
import type { CSSProperties, JSX } from "react";
import { useRouter } from "@tanstack/react-router";
import type { Pose } from "@hercule/client-core";
import { Face } from "../../faces";
import { Markdown } from "../../screens/thread/markdown";
import {
  ASSISTANTS,
  FIX_THREAD_ID,
  FIX_THREAD_LOOK,
  type Entry,
  type Extra,
  type PrototypeAssistant,
} from "./fixture";
import { AlarmIcon, HeartIcon } from "./icons";
import type { OpenMessage } from "./conversation";

const hueStyle = (who: PrototypeAssistant): CSSProperties => ({
  "--hue": `var(--hue-${who.look.hue})`,
});

/** Renders "@Milo" as the colleague's chip: their working face and name in their ink. */
function Mention({ name }: { readonly name: string }): JSX.Element {
  const who = ASSISTANTS.find((each) => each.name === name);
  if (who === undefined) return <>@{name} </>;
  return (
    <span className="mention" style={hueStyle(who)}>
      <Face look={who.look} pose="working" size={18} />
      {who.name}
    </span>
  );
}

/** Splits "@Milo started..." into the name and the rest, or returns `null` without a mention. */
const splitMention = (paragraph: string): { name: string; rest: string } | null => {
  const match = /^@(\w+) /.exec(paragraph);
  return match === null ? null : { name: match[1]!, rest: paragraph.slice(match[0].length) };
};

/** Renders finished paragraphs as markdown; a first paragraph that starts with a mention gets the chip. */
function SettledText({ text }: { readonly text: string }): JSX.Element | null {
  if (text === "") return null;
  const [first, ...rest] = text.split("\n\n");
  const mention = splitMention(first!);
  if (mention === null) return <Markdown text={text} />;
  return (
    <>
      <div className="with-mention">
        <Mention name={mention.name} /> <Markdown text={mention.rest} />
      </div>
      {rest.length === 0 ? null : <Markdown text={rest.join("\n\n")} />}
    </>
  );
}

/**
 * Renders the text of a message being written: the finished paragraphs as
 * markdown, the one being written as plain text with the caret after it, as
 * spec 17 draws a streaming reply.
 */
function OpenText({ open }: { readonly open: OpenMessage }): JSX.Element {
  const written = open.text.slice(0, open.shown);
  const cut = written.lastIndexOf("\n\n");
  const settled = cut === -1 ? "" : written.slice(0, cut);
  const writing = cut === -1 ? written : written.slice(cut + 2);
  const mention = cut === -1 ? splitMention(writing) : null;
  return (
    <>
      <SettledText text={settled} />
      <p className="streaming">
        {mention === null ? (
          writing
        ) : (
          <>
            <Mention name={mention.name} /> {mention.rest}
          </>
        )}
        <span className="caret" />
      </p>
    </>
  );
}

/** Renders what a message carries under its text. */
function MessageExtra({
  extra,
  who,
  onSend,
}: {
  readonly extra: Extra;
  readonly who: PrototypeAssistant;
  readonly onSend: (text: string) => void;
}): JSX.Element {
  const router = useRouter();
  switch (extra.kind) {
    case "refs":
      return (
        <div className="refs">
          <a
            className="ref"
            href={`#/threads/${FIX_THREAD_ID}`}
            onClick={(event) => {
              event.preventDefault();
              router.history.push(`/threads/${FIX_THREAD_ID}`);
            }}
          >
            <Face look={FIX_THREAD_LOOK} pose="waiting" size={22} />
            Fix 3&#8209;D Secure checkout<span className="you-ink">· waiting on you</span>
          </a>
          <button
            type="button"
            className="btn btn--accent btn--sm"
            onClick={() => onSend("Draft it for Marta.")}
          >
            Draft it for Marta
          </button>
        </div>
      );
    case "reminder":
      return (
        <div className="reminder" style={hueStyle(who)}>
          <AlarmIcon size={18} />
          <div>
            <b>{extra.title}</b>
            <span>{extra.when}</span>
          </div>
          <button type="button" className="btn btn--quiet btn--sm" aria-disabled="true">
            Edit
          </button>
        </div>
      );
    case "action":
      return (
        <div className="refs">
          <button
            type="button"
            className="btn btn--accent btn--sm"
            onClick={() => onSend(extra.sends)}
          >
            {extra.label}
          </button>
          <button
            type="button"
            className="btn btn--sm"
            onClick={() => onSend("Not yet, let's talk about it after lunch.")}
          >
            Not yet
          </button>
        </div>
      );
  }
}

/** Renders one assistant message: the face, "Ada · 09:20", the text and its extra. */
export function AssistantMessage({
  who,
  pose,
  label,
  text,
  open,
  extra,
  onSend,
}: {
  readonly who: PrototypeAssistant;
  readonly pose: Pose;
  readonly label: string;
  readonly text: string;
  readonly open?: OpenMessage;
  readonly extra?: Extra | undefined;
  readonly onSend: (text: string) => void;
}): JSX.Element {
  return (
    <div className="msg" style={hueStyle(who)}>
      <Face look={who.look} pose={pose} size={34} animated={pose === "working"} />
      <div className="msg-body">
        <div className="msg-name">
          {who.name} <small>{label}</small>
        </div>
        {open === undefined ? <SettledText text={text} /> : <OpenText open={open} />}
        {extra === undefined || open !== undefined ? null : (
          <MessageExtra extra={extra} who={who} onSend={onSend} />
        )}
      </div>
    </div>
  );
}

/** Renders one entry of the Conversation that is not the open message. */
export function EntryBlock({
  entry,
  who,
  onSend,
}: {
  readonly entry: Entry;
  readonly who: PrototypeAssistant;
  readonly onSend: (text: string) => void;
}): JSX.Element {
  switch (entry.kind) {
    case "stamp":
      return <div className="stamp">{entry.text}</div>;
    case "quiet":
      return (
        <div className="quiet">
          <span>
            {entry.key.startsWith("q-") ? <HeartIcon size={13} /> : null}
            {entry.text}
          </span>
        </div>
      );
    case "notice":
      return (
        <div className={entry.pose === "away" ? "notice notice--away" : "notice"} role="status">
          <Face look={who.look} pose={entry.pose} size={28} />
          <span>
            <b>{entry.lead}</b> {entry.text}
            <span className="time">{entry.time}</span>
          </span>
        </div>
      );
    case "me":
      return (
        <div className="msg--me">
          <div>
            <div className="bubble">
              <Markdown text={entry.text} breaks />
            </div>
            <div className="bubble-meta">{entry.time}</div>
          </div>
        </div>
      );
    case "agent":
      return (
        <AssistantMessage
          who={who}
          pose="idle"
          label={entry.label}
          text={entry.text}
          extra={entry.extra}
          onSend={onSend}
        />
      );
  }
}
