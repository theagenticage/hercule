import { lazy } from "react";

/**
 * `ThreadFirstMoments`, loaded on first use. The Inbox's start-thread dialog
 * needs the transcript only after a thread has started, so the Inbox does not
 * carry that code until then. Render it under Suspense.
 */
export const LazyThreadFirstMoments = lazy(async () => {
  const { ThreadFirstMoments } = await import("./thread-first-moments");
  return { default: ThreadFirstMoments };
});
