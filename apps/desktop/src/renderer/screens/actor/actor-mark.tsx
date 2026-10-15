/**
 * Who wrote something, as the Discussions and Wiki screens draw them: a mark
 * (a face, the user's avatar, or the runs icon) and a name. The two are
 * separate components because the book places them apart, a mark before a
 * name, and each place sizes the mark its own way.
 *
 * The actor is the stamp a record carries: `user`, `session:<id>`, `run:<id>`,
 * `system` or `plugin:<id>`.
 */
import type { JSX } from "react";
import { useRouteContext } from "@tanstack/react-router";
import { useSuspenseQuery } from "@tanstack/react-query";
import { describeActor } from "@hercule/client-core";
import type { Actor } from "@hercule/contract";
import { userQuery } from "../../app/queries";
import { Face, UserAvatar } from "../../faces";
import { RunsIcon } from "../../icons/runs";
import { buildSenderLook } from "../session/sender-chip";
import { useSenderReading } from "../thread/use-sender-reading";
import "./actor.css";

/** The size of the runs icon inside a mark, in CSS pixels. */
const RUN_ICON_SIZE = 14;

/** Renders the empty place of a mark, `size` CSS pixels square, holding `children` when there are any. */
function MarkPlace({
  size,
  children,
}: {
  readonly size: number;
  readonly children?: JSX.Element | null;
}): JSX.Element {
  return (
    <span className="actor-lead" style={{ width: size, height: size }}>
      {children}
    </span>
  );
}

/** Renders the signed-in user's avatar, the first letter of the username. */
function UserMark({ size }: { readonly size: number }): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { username } = useSuspenseQuery(userQuery(controller.client)).data;
  return <UserAvatar name={username} size={size} />;
}

/**
 * Renders the face of the agent of session `sessionId`, `size` CSS pixels
 * square, still and idle. While the session is read it draws an empty place
 * of the same size, so nothing beside it moves when the face arrives.
 */
export function SessionMark({
  sessionId,
  size,
}: {
  readonly sessionId: string;
  readonly size: number;
}): JSX.Element {
  const sender = useSenderReading(sessionId);
  if (sender === "loading") return <MarkPlace size={size} />;
  return <Face look={buildSenderLook(sender)} pose="idle" size={size} />;
}

/**
 * Renders the mark of `actor`, `size` CSS pixels square:
 *
 * - the user is an avatar;
 * - a session's agent is a face (`SessionMark`);
 * - a run is the runs icon;
 * - any other actor is an empty place of the same size, so the names line up.
 */
export function ActorMark({
  actor,
  size,
}: {
  readonly actor: Actor;
  readonly size: number;
}): JSX.Element {
  const { kind, link } = describeActor(actor);
  if (link.kind === "session") return <SessionMark sessionId={link.sessionId} size={size} />;
  if (kind === "user") return <UserMark size={size} />;
  return (
    <MarkPlace size={size}>{kind === "run" ? <RunsIcon size={RUN_ICON_SIZE} /> : null}</MarkPlace>
  );
}

/**
 * Renders the name of the agent of session `sessionId`, "Another agent" when
 * its session cannot be read, and nothing while it is read.
 */
function SessionName({ sessionId }: { readonly sessionId: string }): string {
  const sender = useSenderReading(sessionId);
  return sender === "loading" ? "" : sender.name;
}

/**
 * Renders the name of `actor` as text:
 *
 * - a session's agent by its name (`SessionName`);
 * - any other actor as `describeActor` names it: "You" for the user, "run
 *   4f2a91c0" for a run, and the stamp itself for the rest.
 */
export function ActorName({ actor }: { readonly actor: Actor }): JSX.Element | string {
  const { link, name } = describeActor(actor);
  if (link.kind === "session") return <SessionName sessionId={link.sessionId} />;
  return name;
}
