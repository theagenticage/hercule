/**
 * The Undo key, for the whole shell. One listener hears it on every screen and
 * asks the undo stack to reverse the newest gesture. The stack picks who shows
 * it: the Work or Inbox page that is open, which draws the change and says it
 * on its undo line, or else this file's fallback, which writes the cached Inbox
 * and Work board and says it in a toast.
 */
import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import {
  buildCachedCardMover,
  buildCachedEndedCardMover,
  type CardMover,
} from "../../app/card-mover";
import type { DoneToastStore } from "../../app/done-toast-store";
import type { UndoStack } from "../../app/undo-stack";
import { isTextField } from "../../app/text-field";
import { isUndoKey, OVERLAY_SELECTOR } from "../../screens/desk/desk-keys";
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";

/**
 * Listens for the Undo key while the shell is mounted, and registers the
 * fallback that shows an undo when no desk page is open.
 *
 * The key is left alone when:
 * - focus is in a text field, whose own history the key steps;
 * - the key was already handled, or lands in a menu, a dialog or a side sheet;
 * - the key is held down, so a held key does not undo a row of gestures.
 */
export function useUndoAnywhere({
  client,
  queryClient,
  undoStack,
  toasts,
  platform,
}: {
  readonly client: HerculeClient;
  readonly queryClient: QueryClient;
  readonly undoStack: UndoStack<CardMover>;
  readonly toasts: DoneToastStore;
  readonly platform: DesktopPlatform;
}): void {
  useEffect(() => {
    const mover: CardMover = {
      putCardBack: buildCachedCardMover(client, queryClient),
      putEndedCardBack: buildCachedEndedCardMover(client, queryClient),
    };
    return undoStack.registerFallback({
      buildPage: () => mover,
      report: ({ text, isFailure }) => {
        if (isFailure) toasts.showFailure(text, null);
        else toasts.showNotice(text);
      },
    });
  }, [client, queryClient, undoStack, toasts]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || isTextField(event.target)) return;
      if (!isUndoKey(event, platform)) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(OVERLAY_SELECTOR) != null) return;
      event.preventDefault();
      void undoStack.undo();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [undoStack, platform]);
}
