/**
 * The two kinds of `+` menu, one for a started thread and one for a Draft
 * Thread. Each reads and writes its own list of servers (see
 * `use-thread-servers.ts`) and draws a `PlusMenu`. Loaded when the composer
 * first draws, never with the first screen (see `lazy-thread-servers.ts`).
 */
import type { JSX } from "react";
import type { DraftView, ThreadChoice } from "@hercule/client-core";
import type { Session } from "@hercule/contract";
import type { PlusAttach } from "../session/composer-frame";
import { PlusMenu } from "./plus-menu";
import { useDraftServers, useStartedThreadServers } from "./use-thread-servers";

/** Renders the `+` menu of the started thread `session`, see `PlusMenu`. */
export function StartedThreadPlus({
  session,
  attach,
  serversOff,
  disabled,
}: {
  readonly session: Session;
  readonly attach: PlusAttach;
  readonly serversOff: string | null;
  readonly disabled: boolean;
}): JSX.Element {
  const servers = useStartedThreadServers(session);
  return <PlusMenu attach={attach} servers={servers} serversOff={serversOff} disabled={disabled} />;
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
  const servers = useDraftServers({ view, onChoose });
  return <PlusMenu attach={attach} servers={servers} serversOff={null} disabled={false} />;
}
