/**
 * The question that a workflow's page asks before the author leaves it with
 * changes that are not saved.
 */
import { useEffect } from "react";
import { useBlocker } from "@tanstack/react-router";

/**
 * Holds a navigation to another page while `shouldAsk` is true, so the page
 * can ask first. A change of view stays on the page, so it is never held.
 * When `shouldAsk` turns false while a navigation is held, as when a save
 * lands, nothing is left to ask about, and the navigation goes on.
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
