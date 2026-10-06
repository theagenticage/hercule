/**
 * The assistant's page, as the Bureau book's assistant page draws it in the
 * thread screen's form: the header floating over the Conversation, and the
 * composer floating over its bottom.
 */
import { useDeferredValue, useRef, useState, type JSX, type Ref } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { decideAssistantPose, describePose, queryKeys, type Pose } from "@hercule/client-core";
import type { Assistant, Session, TranscriptRow } from "@hercule/contract";
import {
  assistantsQuery,
  currentConversationSessionQuery,
  runnersQuery,
  runningTurnQuery,
} from "../../app/queries";
import { buildLook, Face, type Look } from "../../faces";
import { NotFound } from "../not-found";
import { useSessionLive, type AttachOpenParagraph } from "../session/use-session-live";
import { Conversation, type ConversationHandle } from "./conversation";
import { ConversationComposer } from "./conversation-composer";
import { useConversationLive } from "./use-conversation-live";
import "../thread/thread-header.css";
import "../thread/thread.css";
import "./assistant.css";

/** Renders the screen shown when no assistant has the id the address names. */
export function AssistantNotFound(): JSX.Element {
  return <NotFound headline="This assistant was not found." />;
}

/**
 * Renders the page of the assistant `assistantId`, or `AssistantNotFound`
 * when the assistant is deleted while the page is open.
 *
 * Everything it reads is in the cache before it renders: the route's loader
 * reads the assistants, the runners and the current session of the
 * assistant's main conversation.
 */
export function AssistantScreen({ assistantId }: { readonly assistantId: string }): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const assistants = useSuspenseQuery(assistantsQuery(client)).data;
  const assistant = assistants.find((each) => each.id === assistantId);
  if (assistant === undefined) return <AssistantNotFound />;
  // Keyed by the assistant, because its main conversation decides which
  // session the page reads.
  return <AssistantPage key={assistant.id} assistant={assistant} />;
}

/** The running turn of a Conversation with no current session: no rows. */
const NO_ROWS: readonly TranscriptRow[] = [];

/**
 * Stands in for the live hook's `attachOpenParagraph` while no session has
 * started. It is never called then, because there is no reply being written.
 */
const attachNothing: AttachOpenParagraph = () => undefined;

/**
 * Renders `assistant`'s header, its Conversation and its composer, and keeps
 * the Conversation's messages current while the page is open.
 *
 * The Conversation is drawn with the session as `useDeferredValue` holds
 * it. When a new session takes over, its running turn is read before the
 * Conversation shows it, and the old one stays on screen until then rather
 * than the page going blank. The header, Stop and the dock follow the
 * current session at once.
 */
function AssistantPage({ assistant }: { readonly assistant: Assistant }): JSX.Element {
  const { client, live } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const session = useSuspenseQuery(
    currentConversationSessionQuery(client, assistant.mainConversationId),
  ).data;
  const shownSession = useDeferredValue(session);
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  useConversationLive(live, queryClient, client, assistant.mainConversationId);
  // The sidebar's row decides its pose with the same function, so the page
  // and the row always show the same pose.
  const pose = decideAssistantPose(
    session,
    session === null ? undefined : runners.find((runner) => runner.id === session.runnerId),
  );
  const look = buildLook(assistant.id);
  // As on the thread screen: the composer's stack is state, because the
  // composer mounts after the Conversation, and the composer shrinks while
  // the reader is away from the bottom, unless the focus is in it.
  const [composerStack, setComposerStack] = useState<HTMLDivElement | null>(null);
  const conversationRef = useRef<ConversationHandle>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [composerFocused, setComposerFocused] = useState(false);
  const shrunk = !atBottom && !composerFocused;

  const conversation = {
    assistant,
    look,
    pose,
    composerStack: shrunk ? null : composerStack,
    onBottomChange: setAtBottom,
    ref: conversationRef,
  };
  return (
    <>
      <AssistantHeader look={look} name={assistant.name} pose={pose} />
      {shownSession === null ? (
        <Conversation
          {...conversation}
          session={null}
          runningTurnRows={NO_ROWS}
          attachOpenParagraph={attachNothing}
        />
      ) : (
        // Keyed by the session, because the live tail it keeps belongs to
        // one session.
        <SessionConversation key={shownSession.id} {...conversation} session={shownSession} />
      )}
      <ConversationComposer
        assistant={assistant}
        session={session}
        look={look}
        shrunk={shrunk}
        onFocusChange={setComposerFocused}
        scrollConversationToBottom={() => {
          conversationRef.current?.scrollToBottom();
        }}
        ref={setComposerStack}
      />
    </>
  );
}

/**
 * Renders the Conversation while `session` is its current session: reads
 * the session's running turn, and keeps it and the reply being written
 * current through the session's live topics. The other props are
 * `Conversation`'s.
 */
function SessionConversation({
  session,
  ...conversation
}: {
  readonly assistant: Assistant;
  readonly look: Look;
  readonly session: Session;
  readonly pose: Pose;
  readonly composerStack: HTMLElement | null;
  readonly onBottomChange: (atBottom: boolean) => void;
  readonly ref?: Ref<ConversationHandle>;
}): JSX.Element {
  const { client, live } = useRouteContext({ from: "/_connected" }).controller;
  const queryClient = useQueryClient();
  const rows = useSuspenseQuery(runningTurnQuery(client, session.id)).data;
  const attachOpenParagraph = useSessionLive(
    live,
    queryClient,
    session.id,
    queryKeys.runningTurn(session.id),
    rows,
  );
  return (
    <Conversation
      {...conversation}
      session={session}
      runningTurnRows={rows}
      attachOpenParagraph={attachOpenParagraph}
    />
  );
}

/**
 * Renders the header that floats over the Conversation: one pill with the
 * assistant's face, its name and the word for its pose. The face moves only
 * while the assistant works, and the word takes the user's ink while the
 * assistant waits on the user.
 */
function AssistantHeader({
  look,
  name,
  pose,
}: {
  readonly look: Look;
  readonly name: string;
  readonly pose: Pose;
}): JSX.Element {
  return (
    <header className="top">
      <span className="pill pill--who">
        <Face look={look} pose={pose} size={24} animated={pose === "working"} />
        <b>{name}</b>
        <span className={pose === "waiting" ? "presence you-ink" : "presence"}>
          {describePose(pose)}
        </span>
      </span>
    </header>
  );
}
