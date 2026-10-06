/**
 * PROTOTYPE (#448). An assistant's Conversation in Crew Bureau, in three
 * variants that disagree about where the rail goes:
 *
 * - A, the book: a header bar, and the rail beside the Conversation.
 * - B, the thread screen's floating header, and the rail in a glass drawer
 *   that the header's pills open.
 * - C, only what the contract holds today: no rail, the Heartbeat in the lip.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type JSX } from "react";
import { useRouterState } from "@tanstack/react-router";
import { describePose } from "@hercule/client-core";
import { Face } from "../../faces";
import { MicIcon } from "../../icons/mic";
import { PlusIcon } from "../../icons/plus";
import { SendIcon } from "../../icons/send";
import { StopIcon } from "../../icons/stop";
import { isSendKey } from "../../screens/thread/send-key";
import { answerAsAda, answerAsHercule, answerAsJuno, answerAsMilo } from "./answers";
import { useConversation, type ConversationSetup, type OpenMessage } from "./conversation";
import {
  ADA,
  ADA_CONVERSATION,
  ADA_SETTLED,
  ASSISTANTS,
  BACKUP_ANSWER,
  BACKUP_ANSWER_CUT,
  HERCULE,
  JUNO,
  JUNO_CONVERSATION,
  MILO,
  MILO_ANSWER,
  MILO_CONVERSATION,
  type PrototypeAssistant,
} from "./fixture";
import { ChatIcon, HeartIcon, MemoryIcon, SettingsIcon, SlackMark } from "./icons";
import { AssistantMessage, EntryBlock } from "./messages";
import { updatePrototype, usePrototype, type ScreenState, type Variant } from "./prototype-state";
import { Rail } from "./rail";

/** Returns how Ada's Conversation opens in `state`, and how the others always open. */
const buildSetup = (who: PrototypeAssistant, state: ScreenState): ConversationSetup => {
  if (who === MILO) {
    return {
      entries: MILO_CONVERSATION,
      open: { text: MILO_ANSWER, shown: 34, label: "answering…" },
      resting: "idle",
      answer: answerAsMilo,
    };
  }
  if (who === JUNO) return { entries: JUNO_CONVERSATION, resting: "asleep", answer: answerAsJuno };
  if (who === HERCULE) return { entries: [], resting: "idle", answer: answerAsHercule };
  switch (state) {
    case "streaming":
      return {
        entries: ADA_CONVERSATION,
        open: { text: BACKUP_ANSWER, shown: BACKUP_ANSWER_CUT, label: "answering…" },
        resting: "idle",
        answer: answerAsAda,
      };
    case "idle":
      return { entries: ADA_SETTLED, resting: "idle", answer: answerAsAda };
    case "approval":
      return {
        entries: [
          ...ADA_CONVERSATION,
          {
            kind: "agent",
            key: "a-look",
            label: "09:38",
            text: "Let me look at last night's backup log on build-box-1 first.",
          },
        ],
        approval: {
          command: "tail -n 200 /var/log/pg-backup.log",
          then: BACKUP_ANSWER,
        },
        resting: "idle",
        answer: answerAsAda,
      };
    case "asleep":
      return { entries: ADA_SETTLED, resting: "asleep", answer: answerAsAda };
    case "unreachable":
      return {
        entries: [
          ...ADA_SETTLED,
          {
            kind: "notice",
            key: "n-away",
            pose: "away",
            lead: "Ada can't be reached:",
            text: "studio-mac, the machine she runs on, has been offline since 09:40.",
            time: "09:40",
          },
        ],
        resting: "away",
        answer: answerAsAda,
      };
  }
};

/** Returns the assistant whose page is open, from the address `/assistants/<id>`. */
function useOpenAssistant(): PrototypeAssistant {
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const id = pathname.split("/").at(-1);
  return ASSISTANTS.find((each) => each.id === id) ?? ADA;
}

/** Renders the open assistant's page, drawn again from the start when the assistant or the state changes. */
export function AssistantScreen(): JSX.Element {
  const who = useOpenAssistant();
  const { variant, state } = usePrototype();
  return (
    <AssistantPage
      key={`${who.id}-${who === ADA ? state : ""}`}
      who={who}
      variant={variant}
      state={state}
    />
  );
}

const openLabel = (open: OpenMessage): string =>
  open.phase === "waking"
    ? "waking up…"
    : open.phase === "thinking"
      ? "thinking…"
      : open.label.startsWith("heartbeat")
        ? open.label
        : "answering…";

function AssistantPage({
  who,
  variant,
  state,
}: {
  readonly who: PrototypeAssistant;
  readonly variant: Variant;
  readonly state: ScreenState;
}): JSX.Element {
  const conversation = useConversation(buildSetup(who, state));
  const { entries, open, pose } = conversation;
  const { heartbeats } = usePrototype();
  const [drawer, setDrawer] = useState(false);

  // Tells the sidebar the pose to draw beside Ada.
  useEffect(() => {
    if (who === ADA) updatePrototype({ adaPose: pose });
  }, [who, pose]);

  // The switcher's "heartbeat now" plays the next hour's heartbeat.
  const seenBeats = useRef(heartbeats);
  useEffect(() => {
    if (heartbeats === seenBeats.current) return;
    seenBeats.current = heartbeats;
    if (who === ADA) conversation.beat();
  });

  const hue = { "--hue": `var(--hue-${who.look.hue})` } as CSSProperties;
  // The rail holds Ada's fixture; Hercule is a fresh install with nothing to show yet.
  const showsRail = who === ADA && variant !== "C";
  const header =
    variant === "B" ? (
      <FloatingHeader
        who={who}
        pose={pose}
        drawer={drawer}
        onDrawer={() => setDrawer(!drawer)}
        hasRail={showsRail}
      />
    ) : (
      <BarHeader who={who} pose={pose} />
    );
  const convo = (
    <div className="convo">
      {variant === "B" ? header : null}
      <Transcript
        who={who}
        conversation={conversation}
        empty={entries.length === 0 && open === null}
      />
      <Composer who={who} conversation={conversation} variant={variant} />
    </div>
  );

  return (
    <div className={`apage apage--${variant}`} style={hue} data-pose={pose}>
      {variant === "B" ? null : header}
      {variant === "A" && showsRail ? (
        <div className="split">
          {convo}
          <Rail who={who} beats={conversation.beats} reminders={conversation.reminders} />
        </div>
      ) : (
        convo
      )}
      {variant === "B" && showsRail ? (
        <Rail
          who={who}
          beats={conversation.beats}
          reminders={conversation.reminders}
          className={drawer ? "rail rail--drawer is-open" : "rail rail--drawer"}
        />
      ) : null}
    </div>
  );
}

/** Renders the book's header bar: the face, the name, the Channels, the model and the record. */
function BarHeader({
  who,
  pose,
}: {
  readonly who: PrototypeAssistant;
  readonly pose: ReturnType<typeof useConversation>["pose"];
}): JSX.Element {
  return (
    <header className="bar">
      <div className="who-head">
        <Face look={who.look} pose={pose} size={30} animated={pose === "working"} />
        <h1 className="title">{who.name}</h1>
        <small>{who.role}</small>
      </div>
      <span className="chan is-on">
        <ChatIcon size={13} />
        Web chat
      </span>
      {who === ADA ? (
        <span className="chan">
          <SlackMark size={12} />
          Slack DM
        </span>
      ) : null}
      <span className="spacer" />
      <span className="time">Claude Code · Sonnet 5</span>
      <button type="button" className="btn btn--sm" aria-disabled="true">
        <SettingsIcon size={14} />
        {who.name}'s record
      </button>
    </header>
  );
}

/** Renders the thread screen's floating header: pills over the Conversation. */
function FloatingHeader({
  who,
  pose,
  drawer,
  onDrawer,
  hasRail,
}: {
  readonly who: PrototypeAssistant;
  readonly pose: ReturnType<typeof useConversation>["pose"];
  readonly drawer: boolean;
  readonly onDrawer: () => void;
  readonly hasRail: boolean;
}): JSX.Element {
  return (
    <header className="top">
      <span className="pill pill--who">
        <Face look={who.look} pose={pose} size={24} animated={pose === "working"} />
        <b>{who.name}</b>
        <span className="presence">{describePose(pose)}</span>
        <span className="pill-sep" />
        <span className="chan is-on">
          <ChatIcon size={13} />
          Web chat
        </span>
        {who === ADA ? (
          <span className="chan">
            <SlackMark size={12} />
            Slack DM
          </span>
        ) : null}
      </span>
      <span className="spacer" />
      {hasRail ? (
        <span className="pill">
          <button
            type="button"
            className={drawer ? "pill-btn is-on" : "pill-btn"}
            aria-pressed={drawer}
            onClick={onDrawer}
            title="Heartbeat, reminders and memory"
          >
            <HeartIcon size={14} />
            10:00
            <span className="pill-dot" />
            <MemoryIcon size={14} />7
          </button>
        </span>
      ) : null}
      <span className="pill">
        <button
          type="button"
          className="icon-btn"
          title={`${who.name}'s record`}
          aria-disabled="true"
        >
          <SettingsIcon />
        </button>
      </span>
    </header>
  );
}

/** Renders the Conversation, following its end while the reader is at the bottom. */
function Transcript({
  who,
  conversation,
  empty,
}: {
  readonly who: PrototypeAssistant;
  readonly conversation: ReturnType<typeof useConversation>;
  readonly empty: boolean;
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const { entries, open, send } = conversation;

  useLayoutEffect(() => {
    const element = ref.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, []);

  // The view follows a new block while the reader is near the bottom.
  const lastKey = entries.at(-1)?.key;
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    if (element.scrollHeight - element.scrollTop - element.clientHeight < 240) {
      element.scrollTop = element.scrollHeight;
    }
  }, [lastKey, open?.key]);

  if (empty) {
    return (
      <div className="transcript" ref={ref} data-transcript>
        <div className="hello-who">
          <Face look={who.look} pose="idle" size={76} />
          <h2>{who.name}</h2>
          <p>
            Send a message to start. {who.name} falls asleep after a quiet spell and picks up where
            it left off.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="transcript" ref={ref} data-transcript>
      <div className="column tx atx">
        {entries.map((entry) => (
          <EntryBlock key={entry.key} entry={entry} who={who} onSend={send} />
        ))}
        {open === null ? null : (
          <AssistantMessage
            key={open.key}
            who={who}
            pose={conversation.approval === null ? "working" : "waiting"}
            label={openLabel(open)}
            text=""
            open={open.phase === "writing" ? open : { ...open, shown: 0 }}
            onSend={send}
          />
        )}
      </div>
      <div className="transcript-end" />
    </div>
  );
}

/** Renders the composer, with the dock above it while a command waits on approval. */
function Composer({
  who,
  conversation,
  variant,
}: {
  readonly who: PrototypeAssistant;
  readonly conversation: ReturnType<typeof useConversation>;
  readonly variant: Variant;
}): JSX.Element {
  const [text, setText] = useState("");
  const [shrunk, setShrunk] = useState(false);
  const [focused, setFocused] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const { open, approval, pose, queued } = conversation;
  const away = pose === "away";
  const busy = open !== null;

  // Shrinks while the Conversation is scrolled more than 12px from its end.
  useEffect(() => {
    const transcript = fieldRef.current?.closest(".convo")?.querySelector("[data-transcript]");
    if (!(transcript instanceof HTMLElement)) return;
    const measure = (): void =>
      setShrunk(transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight > 12);
    transcript.addEventListener("scroll", measure, { passive: true });
    return () => transcript.removeEventListener("scroll", measure);
  }, []);

  const submit = (): void => {
    if (away || text.trim() === "") return;
    conversation.send(text);
    setText("");
  };

  const lipEnd = away
    ? "Messages wait until studio-mac is back"
    : queued.length > 0
      ? `${queued.length} message${queued.length === 1 ? "" : "s"} waiting · sent when ${who.name}'s turn ends`
      : busy
        ? `Replies when ${who === ADA ? "her" : "its"} turn ends`
        : pose === "asleep"
          ? `Asleep · wakes when you write`
          : `Runs on studio-mac`;

  return (
    <div className="composer-wrap">
      <div
        className={shrunk && !focused ? "composer is-scrolled" : "composer"}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onClick={() => {
          if (!shrunk) return;
          const transcript = fieldRef.current
            ?.closest(".convo")
            ?.querySelector("[data-transcript]");
          transcript?.scrollTo({ top: transcript.scrollHeight });
          fieldRef.current?.focus();
        }}
      >
        {approval === null ? null : (
          <div className="dock" role="group" aria-label={`${who.name} wants to run a command`}>
            <div className="fold">
              <div className="dock-q">
                <Face look={who.look} pose="waiting" size={30} />
                <span className="dock-text">
                  {who.name} wants to run <code>{approval.command}</code>
                </span>
              </div>
              <div className="ledger">
                <button type="button" className="ans" onClick={() => conversation.decide(true)}>
                  <span className="btn btn--accent btn--sm">Allow once</span>
                  <span className="ans-desc">Run it this time</span>
                  <kbd aria-hidden="true">↩</kbd>
                </button>
                <button type="button" className="ans" onClick={() => conversation.decide(true)}>
                  <span className="btn btn--sm">Always allow</span>
                  <span className="ans-desc">
                    Allow <code>tail</code> in this Conversation
                  </span>
                  <kbd aria-hidden="true">⌥↩</kbd>
                </button>
                <button type="button" className="ans" onClick={() => conversation.decide(false)}>
                  <span className="btn btn--quiet btn--sm">Deny</span>
                  <span className="ans-desc">{who.name} carries on without it</span>
                  <kbd aria-hidden="true">esc</kbd>
                </button>
              </div>
            </div>
            <div className="dock-mini">
              <Face look={who.look} pose="waiting" size={24} />
              <span className="dock-mini-q">
                Run <code>tail</code>?
              </span>
              <span className="spacer" />
              <button
                type="button"
                className="btn btn--accent btn--sm"
                onClick={() => conversation.decide(true)}
              >
                Allow once
              </button>
              <button
                type="button"
                className="btn btn--quiet btn--sm"
                onClick={() => conversation.decide(false)}
              >
                Deny
              </button>
            </div>
          </div>
        )}
        <div className={away ? "composer-card is-off" : "composer-card"}>
          <textarea
            ref={fieldRef}
            className="composer-input"
            rows={1}
            aria-label="Message"
            readOnly={away}
            aria-disabled={away || undefined}
            placeholder={away ? `${who.name} can't be reached right now` : `Message ${who.name}…`}
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (!isSendKey(event)) return;
              event.preventDefault();
              submit();
            }}
          />
          <div className="fold">
            <div className="composer-row">
              <button type="button" className="icon-btn" title="Attach" aria-disabled="true">
                <PlusIcon />
              </button>
              <span className="spacer" />
              <button type="button" className="icon-btn" title="Dictate" aria-disabled="true">
                <MicIcon />
              </button>
              {busy && text.trim() === "" ? (
                <button
                  type="button"
                  className="stop"
                  title={`Stop ${who.name}'s turn`}
                  onClick={conversation.stop}
                >
                  <StopIcon size={14} />
                </button>
              ) : (
                <button
                  type="button"
                  className={!away && text.trim() !== "" ? "send" : "send send--off"}
                  title={busy ? `Send when ${who.name}'s turn ends` : "Send"}
                  aria-disabled={away || text.trim() === "" || undefined}
                  onClick={submit}
                >
                  <SendIcon />
                </button>
              )}
            </div>
          </div>
        </div>
        <div className="fold">
          <div className="lip">
            {variant === "C" ? (
              <span>
                <HeartIcon size={13} />
                Checks in every hour · next 10:00
              </span>
            ) : (
              <>
                <span>
                  <MemoryIcon size={13} />
                  {who === HERCULE ? "Remembers nothing yet" : "Remembers 7 topics"}
                </span>
                <span>
                  <HeartIcon size={13} />
                  Next heartbeat 10:00
                </span>
              </>
            )}
            <span className="spacer" />
            <span className={queued.length > 0 ? "lip-you" : undefined}>{lipEnd}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
