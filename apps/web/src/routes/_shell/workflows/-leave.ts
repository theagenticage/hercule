import { useEffect } from "react";
import { useBlocker } from "@tanstack/react-router";

/**
 * Blocks navigation to another page while `shouldAsk` is true, so the page
 * can ask the user first. Returns the router's blocker: its `status` is
 * "blocked" while a navigation waits, and `proceed` and `reset` let it go or
 * cancel it.
 *
 * A change of view keeps the same path, so it is never blocked. If
 * `shouldAsk` becomes false while a navigation is blocked, for example
 * because a save finished, the navigation continues.
 */
export const useLeaveBlocker = (shouldAsk: boolean) => {
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) => current.pathname !== next.pathname,
    disabled: !shouldAsk,
    withResolver: true,
  });
  useEffect(() => {
    if (blocker.status === "blocked" && !shouldAsk) blocker.proceed();
  }, [blocker, shouldAsk]);
  return blocker;
};
