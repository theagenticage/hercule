import type { JSX } from "react";
import type { SubagentHue } from "@hercule/client-core";
import type { SubagentStatus } from "@hercule/contract";
import { CancelledMark, DecisionMark, DoneMark, FailedMark, WorkingMark } from "@hercule/ui";

/**
 * Renders a subagent's state mark: the working mark while it runs, the
 * decision mark while it runs and waits on the user, and the done, failed or
 * cancelled mark once it has ended. `waiting` is what `isSubagentWaiting`
 * returns for the subagent.
 */
export function SubagentMark({
  status,
  waiting,
}: {
  readonly status: SubagentStatus;
  readonly waiting: boolean;
}): JSX.Element {
  switch (status) {
    case "running":
      return waiting ? <DecisionMark /> : <WorkingMark />;
    case "completed":
      return <DoneMark />;
    case "failed":
      return <FailedMark />;
    case "stopped":
      return <CancelledMark />;
  }
}

/** The text colour class for each hue a subagent's words are drawn in. */
export const SUBAGENT_HUE_CLASSES: Readonly<Record<SubagentHue, string>> = {
  live: "text-live",
  attn: "text-attn",
  fail: "text-fail",
  muted: "text-muted",
};
