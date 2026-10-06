/**
 * The spawn lines under a work stretch of the transcript: one line per
 * subagent the stretch started, each a link to that subagent's page (spec 17
 * §Thread, Subagents).
 */
import { memo, type JSX } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import { Link, useRouteContext } from "@tanstack/react-router";
import {
  buildSpawnLines,
  describeSubagentState,
  findSpawnedSubagents,
  type SpawnLine,
  type ThreadItem,
} from "@hercule/client-core";
import type { Subagent } from "@hercule/contract";
import { ageClock, useDurationText } from "../../app/age-clock";
import { sessionQuery, subagentsQuery } from "../../app/queries";
import { buildHueStyle } from "../../faces";
import { buildSubagentLook, SubagentFace } from "./subagent-face";
import "./spawn-lines.css";

/** The size of a spawn line's face, in CSS pixels: the prototype's `size={18}`. */
const FACE_SIZE = 18;

/**
 * Renders the lines under a work stretch, one per subagent its `items`
 * started, ordered as the side pane orders them. Renders nothing when the
 * stretch started no subagent whose record has been read.
 *
 * - `sessionId` is the thread's session.
 * - `agentSubagentId` is the agent whose transcript holds the stretch: a
 *   subagent's id on that subagent's page, or undefined for the session's
 *   own agent.
 * - `onScreen` is true while the stretch is in the visible part of the
 *   transcript. A running subagent's duration counts only then.
 *
 * It reads the session and its subagents from the cache, which the thread's
 * loader and the Office's loader fill before the page renders. It is `memo`,
 * so the transcript drawing again on a scroll does not draw it again. That
 * holds because the transcript passes each block's own `items`, which stay
 * the same array until the agent's page builds its blocks again.
 */
export const SpawnLines = memo(function SpawnLines({
  sessionId,
  agentSubagentId,
  items,
  onScreen,
}: {
  readonly sessionId: string;
  readonly agentSubagentId: string | undefined;
  readonly items: readonly ThreadItem[];
  readonly onScreen: boolean;
}): JSX.Element | null {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client } = controller;
  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const subagents = useSuspenseQuery(subagentsQuery(client, sessionId)).data;
  const spawned = findSpawnedSubagents({ items }, agentSubagentId, subagents);
  if (spawned.length === 0) return null;
  // The words and notes do not change with the time; each line reads its
  // own duration from the age clock below.
  const lines = buildSpawnLines(spawned, subagents, session.openRequests, ageClock.readNow());
  // Each line is built from one of `spawned`, so its subagent is always found.
  const spawnedById = new Map(spawned.map((subagent) => [subagent.id, subagent]));
  return (
    <ul className="spawn-lines" aria-label="Subagents started here">
      {lines.map((line) => (
        <SpawnLineRow
          key={line.subagentId}
          sessionId={sessionId}
          subagent={spawnedById.get(line.subagentId)!}
          line={line}
          onScreen={onScreen}
        />
      ))}
    </ul>
  );
});

/**
 * Renders one spawn line: `↳`, the subagent's still face, its name, and on
 * the right its state word, its duration and its notes, as a link to the
 * subagent's page. The line takes the subagent's hue, so the face and the
 * page it opens match.
 *
 * A running subagent's duration counts on the age clock while `onScreen`.
 * An ended one sets no timer.
 */
function SpawnLineRow({
  sessionId,
  subagent,
  line,
  onScreen,
}: {
  readonly sessionId: string;
  readonly subagent: Subagent;
  readonly line: SpawnLine;
  readonly onScreen: boolean;
}): JSX.Element {
  const duration = useDurationText(
    subagent.startedAt,
    subagent.status === "running" && onScreen,
    (now) => describeSubagentState(subagent, line.waiting, new Date(now)).duration,
  );
  return (
    <li>
      <Link
        to="/threads/$sessionId/subagents/$subagentId"
        params={{ sessionId, subagentId: line.subagentId }}
        className="spawn-line"
        style={buildHueStyle(buildSubagentLook(subagent).hue)}
      >
        <span aria-hidden="true" className="spawn-line-arrow">
          ↳
        </span>
        <SubagentFace subagent={subagent} waiting={line.waiting} size={FACE_SIZE} />
        <span className="spawn-line-name" title={line.name}>
          {line.name}
        </span>
        <span className="spawn-line-state">
          <span data-hue={line.state.hue}>{line.state.word}</span>
          {` · ${duration}`}
          {line.notes.map((note) => (
            <span key={note.text} data-hue={note.hue}>
              {` · ${note.text}`}
            </span>
          ))}
        </span>
      </Link>
    </li>
  );
}
