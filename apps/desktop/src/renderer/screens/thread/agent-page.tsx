/**
 * One agent's page on the thread, as the Bureau book's session page draws
 * it: the header floating over the transcript, and the composer floating
 * over its bottom. The agent is the session's own agent, or one of its
 * subagents. A subagent takes no messages, so its page has no composer, and
 * neither has an archived Thread's page.
 */
import { useRef, useState, type JSX, type ReactNode } from "react";
import { Navigate, notFound, useLocation } from "@tanstack/react-router";
import type { Session, Subagent } from "@hercule/contract";
import { isOpenedAtLaunch } from "../../app/last-screen";
import { ArchivedNotice } from "./archived-notice";
import { ThreadComposer } from "./composer";
import { ThreadHeader } from "./thread-header";
import { Transcript, type TranscriptHandle } from "./transcript";
import { SpawnLines } from "../subagents/spawn-lines";
import { useLiveThreadBlocks } from "./use-live-thread-blocks";
import "../session/transcript.css";
import "./thread.css";

/** What a subagent's page draws of its own, from the records the page reads. */
export interface SubagentParts {
  /** Drawn in the thread header's place: the crumb down to the subagent. */
  readonly header: ReactNode;
  /** Drawn above the transcript's first block: the brief card. */
  readonly lead: ReactNode;
  /** Drawn in the composer's place: the status card and what sits on it. */
  readonly bottom: ReactNode;
}

/**
 * Returns what a subagent's page draws of its own, for `subagent`, given the
 * thread's session, its subagents, and the brief the subagent's parent gave
 * it (undefined while the transcript does not hold it yet).
 */
export type DrawSubagentParts = (records: {
  readonly session: Session;
  readonly subagent: Subagent;
  readonly subagents: readonly Subagent[];
  readonly brief: string | undefined;
}) => SubagentParts;

/**
 * Renders the page of one agent of the thread `sessionId`: the session's own
 * agent when `subagentId` is undefined, else that subagent.
 *
 * - The session's own agent's page has the header, the transcript and the
 *   composer. When the Thread is archived, a line with a New thread button
 *   takes the composer's place (`ArchivedNotice`).
 * - A subagent's page has its transcript, with faces seeded
 *   `<sessionId>:<subagentId>`, and the parts `drawSubagentParts` returns:
 *   its own header, the brief above the transcript and the status card in
 *   the composer's place. The subagent's page passes them in, so they load
 *   with that page rather than with the thread's.
 *
 * Under each work stretch that started subagents, the transcript draws
 * their spawn lines, which link to their pages.
 *
 * Mount it keyed by `<sessionId>/<subagentId>`, because the live tail it
 * keeps belongs to one agent. The Office's thread drawer mounts the
 * session's own agent's page outside the thread's route, where there is no
 * side pane, so the page leaves out the tally pill and the pane toggle.
 *
 * Everything it reads is in the cache before it renders: the shell's loader
 * reads the providers and runners, the thread's loader (or the Office's,
 * for the drawer) the session and its subagents, and each page's loader the
 * agent's transcript. While it is mounted, the agent's stream and tap keep
 * the transcript and the tail current.
 *
 * A thread that opened from its saved copy holds the copy's rows until the
 * transcript's query has merged the rows written since (`useSessionLive`
 * follows the stream after that). When that read finds that the thread no
 * longer exists and the page is in the thread's route (`inThreadRoute`), the page shows the
 * thread's not-found screen, or goes to the new-thread screen when the app
 * opened the thread at launch. Elsewhere, such as in the Office's drawer,
 * the page keeps showing what it holds: leaving a route that is not on
 * screen would throw `notFound` for the wrong route or navigate away from
 * the Office.
 *
 * Fails with `notFound` when the session has no subagent `subagentId`.
 */
export function AgentPage({
  sessionId,
  subagentId,
  drawSubagentParts,
  inThreadRoute,
}: {
  /** Whether the page is drawn by the thread's route, as opposed to the Office's drawer. */
  readonly inThreadRoute: boolean;
} & (
  | {
      readonly sessionId: string;
      readonly subagentId: undefined;
      readonly drawSubagentParts?: undefined;
    }
  | {
      readonly sessionId: string;
      /** The subagent whose page this is. */
      readonly subagentId: string;
      readonly drawSubagentParts: DrawSubagentParts;
    }
)): JSX.Element {
  // Only the flag is read, so a navigation does not draw the page again.
  const isAtLaunch = useLocation({ select: isOpenedAtLaunch });
  const {
    session,
    subagent,
    subagents,
    brief,
    blocks,
    pose,
    faceSeed,
    describeAgent,
    attachOpenParagraph,
    isGone,
  } = useLiveThreadBlocks(sessionId, subagentId);
  // The transcript sizes its bottom padding from the composer's stack. The
  // stack is held as state, not a ref, because the composer mounts after the
  // transcript: its element exists only once the transcript's effects ran,
  // and the state change runs them again with it.
  const [composerStack, setComposerStack] = useState<HTMLDivElement | null>(null);
  const transcriptRef = useRef<TranscriptHandle>(null);
  // The composer shrinks while the reader is away from the bottom of the
  // transcript, unless the focus is in the composer. A subagent's status
  // card and an archived Thread's line never shrink, so the transcript always
  // clears them.
  const [atBottom, setAtBottom] = useState(true);
  const [composerFocused, setComposerFocused] = useState(false);
  const shrunk =
    subagent === undefined && session.archived === undefined && !atBottom && !composerFocused;

  if (inThreadRoute && isGone) {
    // The transcript read found that the thread no longer exists, which the saved
    // copy could not know. Show what the thread's loader shows for it, see
    // `throwScreenNotFound`. A redirect cannot be thrown from a component.
    if (isAtLaunch) return <Navigate to="/" replace />;
    // The thread's own page has no not-found screen of its own, so the thread
    // route's shows. A subagent's route has one, which says the same.
    // oxlint-disable-next-line typescript/only-throw-error
    throw notFound(
      subagentId === undefined ? { routeId: "/_connected/_shell/threads/$sessionId" } : undefined,
    );
  }
  const subagentParts =
    subagent === undefined || drawSubagentParts === undefined
      ? undefined
      : drawSubagentParts({ session, subagent, subagents, brief });

  return (
    <>
      {subagentParts === undefined ? <ThreadHeader session={session} /> : subagentParts.header}
      <Transcript
        sessionId={sessionId}
        faceSeed={faceSeed}
        blocks={blocks}
        lead={subagentParts?.lead}
        pose={pose}
        describeAgent={describeAgent}
        attachOpenParagraph={attachOpenParagraph}
        composerStack={shrunk ? null : composerStack}
        onBottomChange={setAtBottom}
        renderSpawnLines={(items, onScreen) => (
          <SpawnLines
            sessionId={sessionId}
            agentSubagentId={subagentId}
            items={items}
            onScreen={onScreen}
          />
        )}
        ref={transcriptRef}
      />
      {subagentParts !== undefined ? (
        // A subagent takes no messages, so its status card takes the
        // composer's place. The stack is passed to `setComposerStack`, so the
        // transcript's last line clears the card and what sits on it.
        <div className="composer-wrap">
          <div className="composer" ref={setComposerStack}>
            {subagentParts.bottom}
          </div>
        </div>
      ) : session.archived !== undefined ? (
        <ArchivedNotice session={session} ref={setComposerStack} />
      ) : (
        <ThreadComposer
          sessionId={sessionId}
          shrunk={shrunk}
          onFocusChange={setComposerFocused}
          scrollTranscriptToBottom={() => {
            transcriptRef.current?.scrollToBottom();
          }}
          ref={setComposerStack}
        />
      )}
    </>
  );
}
