import type { KeyboardEvent } from "react";

/**
 * Checks whether a keydown in a message field sends the message: ⏎ sends, and
 * ⇧⏎ starts a new line. The thread's composer and a Draft Thread's both use
 * it.
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
