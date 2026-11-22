/**
 * The two kinds of `+` menu, one for a started thread and one for a Draft
 * Thread. Each makes the edits of its own list (see `use-thread-edits.ts`)
 * and draws a `PlusMenu`. Loaded when the composer first draws, never with
 * the first screen (see `lazy-thread-servers.ts`).
 */
import type { JSX } from "react";
import type { DraftView, ThreadChoice } from "@hercule/client-core";
import type { Session } from "@hercule/contract";
import type { PlusAttach } from "../session/composer-frame";
import { PlusMenu } from "./plus-menu";
import { useDraftEdits, useStartedThreadEdits } from "./use-thread-edits";

/** Renders the `+` menu of the started thread `session`, see `PlusMenu`. */
export function StartedThreadPlus({
  session,
  attach,
  serversOff,
}: {
  readonly session: Session;
  readonly attach: PlusAttach;
  readonly serversOff: string | null;
}): JSX.Element {
  const edits = useStartedThreadEdits(session);
  return <PlusMenu attach={attach} edits={edits} serversOff={serversOff} />;
}

/** Renders the `+` menu of the Draft Thread `view`; a change goes to `onChoose`, see `PlusMenu`. */
export function DraftPlus({
  view,
  onChoose,
  attach,
}: {
  readonly view: DraftView;
  readonly onChoose: (choice: ThreadChoice) => void;
  readonly attach: PlusAttach;
}): JSX.Element {
  const edits = useDraftEdits({ view, onChoose });
  return <PlusMenu attach={attach} edits={edits} serversOff={null} />;
}
