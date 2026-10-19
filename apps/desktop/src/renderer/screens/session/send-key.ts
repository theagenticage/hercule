import { useEffect, useEffectEvent } from "react";
import { useRouteContext } from "@tanstack/react-router";

/**
 * Checks whether a keydown belongs to an IME composition, so the field must
 * not treat it as a command. Chromium marks such a key with `isComposing`,
 * and some input methods, Safari's among them, with the legacy `keyCode`
 * 229, "the IME handled this key". The ⏎ that confirms a Japanese or Chinese
 * word is one of these keys.
 */
export const isImeKey = (event: KeyboardEvent): boolean =>
  event.isComposing || event.keyCode === 229;

/**
 * Checks whether a keydown in a message field sends the message: ⏎ sends, and
 * ⇧⏎ starts a new line. `MessageField` and the dock use it. The ⏎ that ends
 * an IME composition does not send (see `isImeKey`), or it would cut a
 * sentence off mid-word.
 */
export const isSendKey = (event: KeyboardEvent): boolean =>
  event.key === "Enter" && !event.shiftKey && !isImeKey(event);

/**
 * Calls `send` when the user chooses Thread > Send in the menu, or presses
 * its ⌘↵ while the focus is outside the message field. In the field, ⌘↵ is a
 * send key, and the field's own handler sends. The thread's composer, a
 * Draft Thread's and an assistant's Conversation's all use it; only one of
 * them is on screen at a time.
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
