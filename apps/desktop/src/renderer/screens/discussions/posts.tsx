/**
 * The Posts of an open Discussion, oldest first (spec 19 section 8.2). A
 * Post from a session's agent shows its face, its name as a link to its
 * thread, its time, and its text as Markdown. A system Post is one quiet
 * line. The list is drawn whole, because a Discussion holds at most 200 Posts
 * and 200 system Posts.
 *
 * Each Post is memoized and takes only strings, so when a push adds a Post,
 * only the new one is drawn.
 */
import { memo, type JSX } from "react";
import { readActorSessionId } from "@hercule/client-core";
import type { Actor, Post } from "@hercule/contract";
import { buildHueStyle, Face } from "../../faces";
import { OverlapIcon } from "../../icons/overlap";
import { ActorMark, ActorName } from "../actor/actor-mark";
import { SenderNameLink } from "../actor/sender-names";
import { Markdown } from "../session/markdown";
import { buildSenderLook } from "../session/sender-chip";
import { useSenderReading } from "../thread/use-sender-reading";
import { InlineCode } from "./inline-code";
import { usePostTime } from "./post-time";
import "../session/messages.css";
import "../list-pane/open-item.css";
import "./discussions.css";

/** The size of a Post's face, in CSS pixels: the transcript's. */
const POST_FACE_SIZE = 34;

/** The size of the icon in front of a system Post, in CSS pixels. */
const SYSTEM_ICON_SIZE = 12;

/** The values a Post draws. */
interface PostProps {
  readonly text: string;
  readonly createdAt: string;
  /** The time zone the time is shown in. */
  readonly timezone: string;
}

/**
 * Renders a system Post: the overlap icon, then the controller's text, whose
 * code spans are drawn as code, then its time. The text is not Markdown (see
 * `InlineCode`).
 */
const SystemPost = memo(function SystemPost({ text, createdAt, timezone }: PostProps): JSX.Element {
  const time = usePostTime(createdAt, timezone);
  return (
    <p className="post-system">
      <OverlapIcon size={SYSTEM_ICON_SIZE} />
      <span>
        {/* The space joins the text's last node: a space in a node of its own can
            measure a hair wider than the same space inside the text. */}
        <InlineCode text={`${text} `} />
        <time dateTime={createdAt}>{time}</time>
      </span>
    </p>
  );
});

/**
 * Renders a Post from the agent of session `sessionId`: its face, its name
 * linked to its thread, and the time, then the text as Markdown. The name
 * stays empty while the session is read, because a name shown first and
 * replaced later would print one that is wrong.
 */
const SessionPost = memo(function SessionPost({
  sessionId,
  text,
  createdAt,
  timezone,
}: PostProps & { readonly sessionId: string }): JSX.Element {
  const sender = useSenderReading(sessionId);
  const time = usePostTime(createdAt, timezone);
  return (
    <div
      className="msg"
      style={sender === "loading" ? undefined : buildHueStyle(buildSenderLook(sender).hue)}
    >
      {sender === "loading" ? (
        <span />
      ) : (
        <Face look={buildSenderLook(sender)} pose="idle" size={POST_FACE_SIZE} />
      )}
      <div className="msg-body">
        <div className="msg-name">
          {sender === "loading" ? null : <SenderNameLink sender={sender} />}
          <small>{time}</small>
        </div>
        <Markdown text={text} />
      </div>
    </div>
  );
});

/**
 * Renders a Post from an actor that has no face: the user, a run, or any other
 * actor, with its mark and its name (`ActorMark`, `ActorName`).
 */
const ActorPost = memo(function ActorPost({
  actor,
  text,
  createdAt,
  timezone,
}: PostProps & { readonly actor: Actor }): JSX.Element {
  const time = usePostTime(createdAt, timezone);
  return (
    <div className="msg">
      <ActorMark actor={actor} size={POST_FACE_SIZE} />
      <div className="msg-body">
        <div className="msg-name">
          <span>
            <ActorName actor={actor} />
          </span>
          <small>{time}</small>
        </div>
        <Markdown text={text} />
      </div>
    </div>
  );
});

/** Renders `posts` under a heading, oldest first, each as its author's kind of Post. */
export function Posts({
  posts,
  timezone,
}: {
  readonly posts: readonly Post[];
  readonly timezone: string;
}): JSX.Element {
  return (
    <>
      <h2 className="sec-h">
        <span>Posts</span>
      </h2>
      <div className="posts">
        {posts.map((post) => {
          const { actor, text, createdAt } = post;
          if (actor === "system") {
            return (
              <SystemPost key={post.id} text={text} createdAt={createdAt} timezone={timezone} />
            );
          }
          const sessionId = readActorSessionId(actor);
          return sessionId === undefined ? (
            <ActorPost
              key={post.id}
              actor={actor}
              text={text}
              createdAt={createdAt}
              timezone={timezone}
            />
          ) : (
            <SessionPost
              key={post.id}
              sessionId={sessionId}
              text={text}
              createdAt={createdAt}
              timezone={timezone}
            />
          );
        })}
      </div>
    </>
  );
}
