import { useEffect, useEffectEvent, type KeyboardEvent } from "react";
import { useRouteContext } from "@tanstack/react-router";

/**
 * Checks whether a keydown in a message field sends the message: ⏎ sends, and
 * ⇧⏎ starts a new line. `ComposerFrame`, a Draft Thread's composer and the
 * dock use it.
 *
 * The ⏎ that ends an IME composition does not send, or it would cut a
 * Japanese or Chinese sentence off mid-word. Chromium marks that ⏎ with
 * `isComposing`, and some input methods with the legacy `keyCode` 229, "the
 * IME handled this key".
 */
export const isSendKey = (event: KeyboardEvent): boolean =>
  event.key === "Enter" &&
  !event.shiftKey &&
  !event.nativeEvent.isComposing &&
  event.keyCode !== 229;

/**
 * Calls `send` when the user chooses Thread > Send in the menu, or presses
 * its ⌘↵ while the focus is outside the message field. In the field, ⌘↵ is a
 * send key, and the field's own handler sends. The thread's composer and a
 * Draft Thread's both use it; only one of them is on screen at a time.
 */
export const useSendOnMenuCommand = (send: () => void): void => {
  const { bridge } = useRouteContext({ from: "/_connected" });
  const sendNow = useEffectEvent(send);
  useEffect(
    () =>
      bridge.menu.onCommand((command) => {
        if (command === "send") sendNow();
      }),
    [bridge],
  );
};
