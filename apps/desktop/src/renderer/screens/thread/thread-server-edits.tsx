/**
 * Gives the submenu and the picker of the composer's `+` the edits of their
 * thread's list. This file loads with them (see `lazy-thread-servers.ts`),
 * never with the first screen, because the edits pull in the code that
 * resolves and writes a list.
 */
import type { JSX, ReactNode } from "react";
import type { DraftView, ThreadChoice } from "@hercule/client-core";
import type { Session } from "@hercule/contract";
import { useDraftEdits, useStartedThreadEdits, type ThreadServerEdits } from "./use-thread-edits";

/** The thread whose list the `+` menu edits: a started thread, or a Draft Thread that keeps the change as a pick. */
export type ThreadServersTarget =
  | { readonly kind: "started"; readonly session: Session }
  | {
      readonly kind: "draft";
      readonly view: DraftView;
      readonly onChoose: (choice: ThreadChoice) => void;
    };

/**
 * Renders `children` with the edits of the list of `target`. The edits are
 * the list's, not the menu's or the picker's, so a refusal they hold shows
 * again when either is opened later.
 */
export function WithThreadServerEdits({
  target,
  children,
}: {
  readonly target: ThreadServersTarget;
  readonly children: (edits: ThreadServerEdits) => ReactNode;
}): JSX.Element {
  return target.kind === "started" ? (
    <StartedEdits session={target.session}>{children}</StartedEdits>
  ) : (
    <DraftEdits view={target.view} onChoose={target.onChoose}>
      {children}
    </DraftEdits>
  );
}

function StartedEdits({
  session,
  children,
}: {
  readonly session: Session;
  readonly children: (edits: ThreadServerEdits) => ReactNode;
}): JSX.Element {
  const edits = useStartedThreadEdits(session);
  return <>{children(edits)}</>;
}

function DraftEdits({
  view,
  onChoose,
  children,
}: {
  readonly view: DraftView;
  readonly onChoose: (choice: ThreadChoice) => void;
  readonly children: (edits: ThreadServerEdits) => ReactNode;
}): JSX.Element {
  const edits = useDraftEdits({ view, onChoose });
  return <>{children(edits)}</>;
}
