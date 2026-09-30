import { useEffect, useRef } from "react";

/**
 * Sends `value` with `send` after the first render, and after each render in
 * which `value` differs from the value last sent. Values are compared as
 * JSON. A send that fails is logged to the console with `failureMessage` and
 * is not tried again.
 *
 * Most renders leave the value as it was, and main does work for each value it
 * is sent, such as building the whole menu bar again for each Go menu list.
 */
export function useSendOnChange<Value>(
  value: Value,
  send: (value: Value) => Promise<void>,
  failureMessage: string,
): void {
  const key = JSON.stringify(value);
  const sentKey = useRef<string | null>(null);
  useEffect(() => {
    if (sentKey.current === key) return;
    sentKey.current = key;
    send(value).catch((error: unknown) => {
      console.error(failureMessage, error);
    });
  });
}
