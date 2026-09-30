/**
 * The thread screen, as the Bureau book's session page draws it: the header
 * floating over the transcript, and the composer floating over its bottom.
 */
import { useRef, useState, type JSX } from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import { buildThreadBlocks, decideThreadPose, describeAgent } from "@hercule/client-core";
import { providersQuery, runnersQuery, sessionQuery, transcriptQuery } from "../../app/queries";
import { ThreadComposer } from "./composer";
import { ThreadHeader } from "./thread-header";
import { Transcript, type TranscriptHandle } from "./transcript";
import { useThreadLive } from "./use-thread-live";
import "./thread.css";

/**
 * Renders the thread `sessionId`: the header, the transcript and the
 * composer. The route mounts it keyed by the session id, because the live
 * tail it keeps belongs to one thread.
 *
 * Everything it reads is in the cache before it renders: the shell's loader
 * reads the providers and runners, and the thread route's loader the session
 * and its transcript. While it is mounted, the thread's stream and tap keep
 * the transcript and the tail current.
 */
export function ThreadScreen({ sessionId }: { readonly sessionId: string }): JSX.Element {
  const { controller } = useRouteContext({ from: "/_connected" });
  const { client, live } = controller;
  const queryClient = useQueryClient();
  const session = useSuspenseQuery(sessionQuery(client, sessionId)).data;
  const rows = useSuspenseQuery(transcriptQuery(client, sessionId)).data;
  const instances = useSuspenseQuery(providersQuery(client)).data;
  const runners = useSuspenseQuery(runnersQuery(client)).data;
  const attachOpenParagraph = useThreadLive(live, queryClient, sessionId, rows);
  // The transcript sizes its bottom padding from the composer's stack. The
  // stack is held as state, not a ref, because the composer mounts after the
  // transcript: its element exists only once the transcript's effects ran,
  // and the state change runs them again with it.
  const [composerStack, setComposerStack] = useState<HTMLDivElement | null>(null);
  const transcriptRef = useRef<TranscriptHandle>(null);
  // The composer shrinks while the reader is away from the bottom of the
  // transcript, unless the focus is in the composer.
  const [atBottom, setAtBottom] = useState(true);
  const [composerFocused, setComposerFocused] = useState(false);
  const shrunk = !atBottom && !composerFocused;

  const blocks = buildThreadBlocks(rows, session);
  const runner =
    session.runnerId === null ? undefined : runners.find((each) => each.id === session.runnerId);
  const instance = instances.find((each) => each.id === session.instanceId);

  return (
    <>
      <ThreadHeader sessionId={sessionId} />
      <Transcript
        sessionId={sessionId}
        blocks={blocks}
        pose={decideThreadPose(session, runner)}
        describeAgent={(model) => describeAgent(instance, model)}
        attachOpenParagraph={attachOpenParagraph}
        composerStack={shrunk ? null : composerStack}
        onBottomChange={setAtBottom}
        ref={transcriptRef}
      />
      <ThreadComposer
        sessionId={sessionId}
        shrunk={shrunk}
        onFocusChange={setComposerFocused}
        scrollTranscriptToBottom={() => {
          transcriptRef.current?.scrollToBottom();
        }}
        ref={setComposerStack}
      />
    </>
  );
}
