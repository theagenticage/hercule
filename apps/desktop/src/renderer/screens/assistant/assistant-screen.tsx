/**
 * The assistant's page, as the Bureau book's assistant page draws it in the
 * thread screen's form: the header floating over the Conversation.
 */
import type { JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { decideAssistantPose, describePose, type Pose } from "@hercule/client-core";
import type { Assistant } from "@hercule/contract";
import { assistantsQuery, currentConversationSessionQuery, runnersQuery } from "../../app/queries";
import { buildLook, Face, type Look } from "../../faces";
import { NotFound } from "../not-found";
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

/** Renders `assistant`'s header and its Conversation, which holds no messages yet. */
function AssistantPage({ assistant }: { readonly assistant: Assistant }): JSX.Element {
  const { client } = useRouteContext({ from: "/_connected" }).controller;
  const session = useSuspenseQuery(
    currentConversationSessionQuery(client, assistant.mainConversationId),
  ).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  // The sidebar's row decides its pose with the same function, so the page
  // and the row always show the same pose.
  const pose = decideAssistantPose(
    session,
    session === null ? undefined : runners.find((runner) => runner.id === session.runnerId),
  );
  const look = buildLook(assistant.id);
  return (
    <>
      <AssistantHeader look={look} name={assistant.name} pose={pose} />
      <div className="transcript">
        <div className="hello-who">
          <Face look={look} pose="idle" size={76} />
          <h2>{assistant.name}</h2>
          <p>
            Send a message to start. {assistant.name} falls asleep after a quiet spell and picks up
            where it left off.
          </p>
        </div>
      </div>
    </>
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
