/**
 * Gives the submenu and the picker of the composer's `+` the edits of their
 * thread's list. This file loads with them (see `lazy-thread-servers.ts`),
 * never with the first screen, because the edits pull in the code that
 * resolves and writes a list.
 */
import { useEffect, type JSX, type ReactNode, type RefObject } from "react";
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
 * Renders `children` with the edits of the list of `target`. While it is
 * drawn, `clearRefusalRef` holds the function that forgets a settled refusal,
 * so the `+` menu, which never loads the edits itself, can clear it when the
 * user closes the menu or the picker that showed it.
 */
export function WithThreadServerEdits({
  target,
  clearRefusalRef,
  children,
}: {
  readonly target: ThreadServersTarget;
  readonly clearRefusalRef: RefObject<(() => void) | null>;
  readonly children: (edits: ThreadServerEdits) => ReactNode;
}): JSX.Element {
  return target.kind === "started" ? (
    <StartedEdits session={target.session} clearRefusalRef={clearRefusalRef}>
      {children}
    </StartedEdits>
  ) : (
    <DraftEdits view={target.view} onChoose={target.onChoose} clearRefusalRef={clearRefusalRef}>
      {children}
    </DraftEdits>
  );
}

function StartedEdits({
  session,
  clearRefusalRef,
  children,
}: {
  readonly session: Session;
  readonly clearRefusalRef: RefObject<(() => void) | null>;
  readonly children: (edits: ThreadServerEdits) => ReactNode;
}): JSX.Element {
  const edits = useStartedThreadEdits(session);
  useRegisterClearRefusal(clearRefusalRef, edits);
  return <>{children(edits)}</>;
}

function DraftEdits({
  view,
  onChoose,
  clearRefusalRef,
  children,
}: {
  readonly view: DraftView;
  readonly onChoose: (choice: ThreadChoice) => void;
  readonly clearRefusalRef: RefObject<(() => void) | null>;
  readonly children: (edits: ThreadServerEdits) => ReactNode;
}): JSX.Element {
  const edits = useDraftEdits({ view, onChoose });
  useRegisterClearRefusal(clearRefusalRef, edits);
  return <>{children(edits)}</>;
}

/** Puts the edits' `clearRefusal` in `clearRefusalRef`, where it stays after the component unmounts. */
function useRegisterClearRefusal(
  clearRefusalRef: RefObject<(() => void) | null>,
  edits: ThreadServerEdits,
): void {
  const { clearRefusal } = edits;
  useEffect(() => {
    clearRefusalRef.current = clearRefusal;
  }, [clearRefusalRef, clearRefusal]);
}
