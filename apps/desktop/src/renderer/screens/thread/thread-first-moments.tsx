/**
 * The first moments of a Thread, read-only: the user's message at the top,
 * then the agent's first events and words, streaming live. It has no header
 * and no composer. The start-thread dialog shows it once the Thread has
 * started.
 */
import type { JSX } from "react";
import { Transcript } from "./transcript";
import { useLiveThreadBlocks } from "./use-live-thread-blocks";
import "../session/transcript.css";
import "./thread.css";

/** Does nothing: the dialog's transcript has no composer that reacts to where the reader is. */
const ignoreBottomChange = (): void => {};

/**
 * Renders the transcript of the Thread `sessionId`'s own agent, read-only,
 * and keeps it live while mounted. It scrolls inside its container, which
 * must give it a height (such as a flex child with `min-height: 0`), and it
 * follows the bottom as the agent writes until the reader scrolls up.
 *
 * Suspends until the Thread's reads are loaded, so the caller wraps it in
 * Suspense. Mount it keyed by `sessionId`.
 */
export function ThreadFirstMoments({ sessionId }: { readonly sessionId: string }): JSX.Element {
  const { blocks, pose, faceSeed, describeAgent, attachOpenParagraph } = useLiveThreadBlocks(
    sessionId,
    undefined,
  );
  return (
    <Transcript
      sessionId={sessionId}
      faceSeed={faceSeed}
      blocks={blocks}
      pose={pose}
      describeAgent={describeAgent}
      attachOpenParagraph={attachOpenParagraph}
      composerStack={null}
      onBottomChange={ignoreBottomChange}
      layout="embedded"
    />
  );
}
