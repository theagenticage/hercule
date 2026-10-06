import type { JSX } from "react";
import type { HerculeClient } from "@hercule/client-core";
import type { Session, Subagent } from "@hercule/contract";

/**
 * The thread's side pane, to the right of the main pane: a container of
 * surfaces shown as tabs, of which Subagents is the only one (spec 14
 * §Subagents on the thread surface). The thread's layout route puts it in
 * the shell's side-pane slot, so it stays as it was while the main pane
 * moves between the thread's page and its subagents' pages.
 *
 * Not built yet: it renders nothing.
 */
export const SidePane: (props: {
  readonly client: HerculeClient;
  readonly session: Session;
  /** Every subagent of the session, oldest first. */
  readonly subagents: readonly Subagent[];
  /** The subagent whose page is open in the main pane; undefined on the thread's own page. */
  readonly subagentId: string | undefined;
}) => JSX.Element | null = () => null;
