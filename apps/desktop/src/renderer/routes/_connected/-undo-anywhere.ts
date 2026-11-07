/**
 * The Undo key on the screens that have no gestures of their own. Work and the
 * Inbox listen for the key themselves, because they draw the change on the
 * page and say what happened on their undo line. Every other screen (the
 * Office, Intake, Settings, a thread) has neither, so the shell listens for
 * them.
 */
import { useEffect } from "react";
import type { QueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { buildCachedCardMover, buildCachedInboxWriter, type CardMover } from "../../app/card-mover";
import type { DoneToastStore } from "../../app/done-toast-store";
import { describeUndoOutcome, type UndoStack } from "../../app/undo-stack";
import { isTextField } from "../../app/text-field";
import { isUndoKey, OVERLAY_SELECTOR } from "../../screens/desk/desk-keys";
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";

/**
 * Listens for the Undo key while the shell is mounted, and reverses the newest
 * gesture of `undoStack` through the cached Inbox and Work board, with the
 * result in `toasts`.
 *
 * The key is left alone when:
 * - a page of the desk is open (`UndoStack.hasOpenPage`), because that page
 *   undoes the gesture itself, so a key never undoes twice;
 * - focus is in a text field, whose own history the key steps;
 * - the key was already handled, or lands in a menu, a dialog or a sheet;
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
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.repeat || isTextField(event.target)) return;
      if (!isUndoKey(event, platform) || undoStack.hasOpenPage()) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(OVERLAY_SELECTOR) != null) return;
      event.preventDefault();
      void undoStack
        .undo({
          putCardBack: buildCachedCardMover(client, queryClient),
          writeInboxEdit: buildCachedInboxWriter(queryClient),
        })
        .then((outcome) => {
          const report = describeUndoOutcome(outcome);
          if (report === undefined) return;
          if (report.isFailure) toasts.showFailure(report.text, null);
          else toasts.showNotice(report.text);
        });
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [client, queryClient, undoStack, toasts, platform]);
}
