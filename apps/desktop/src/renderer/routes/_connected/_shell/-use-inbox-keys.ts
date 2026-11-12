import { useEffect, useRef } from "react";
import {
  decideInboxKeyAction,
  readInboxKeyPlace,
  type InboxKeyAction,
} from "../../../screens/inbox/inbox-keys";

/** Matches the controls that answer Return and Space themselves. */
const CONTROL_SELECTOR = "button, a[href], [role='button'], [role='separator']";

/**
 * Listens for the Inbox's keys while the screen is mounted, and calls
 * `perform` with what each key asks for (`decideInboxKeyAction`). A key the
 * Inbox acts on is stopped from doing its own thing. Single keys act only in
 * the list and the pane, as `inbox-keys` says.
 *
 * It leaves a key alone when it was already handled elsewhere, such as by an
 * open menu. ⌘Z is the shell's (`useUndoAnywhere`), not this screen's.
 */
export function useInboxKeys(perform: (action: InboxKeyAction) => void): void {
  // The newest `perform`, so the listener is added once and always acts on the newest state.
  const latest = useRef(perform);
  useEffect(() => {
    latest.current = perform;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      const target = event.target;
      const action = decideInboxKeyAction(
        {
          key: event.key,
          shiftKey: event.shiftKey,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          repeat: event.repeat,
          isOnControl: target instanceof Element && target.closest(CONTROL_SELECTOR) !== null,
        },
        readInboxKeyPlace(target),
      );
      if (action === null) return;
      event.preventDefault();
      latest.current(action);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, []);
}
