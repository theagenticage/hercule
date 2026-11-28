/**
 * Which open signals the desktop app notifies natively: the urgent ones about
 * an External Entity, whose Inbox pane the notification opens.
 */
import type { Signal } from "@hercule/contract";
import { parsePluginId } from "./plugin-id";
import { CORE_SOURCE_NAME, namePlugin, type PluginName } from "./plugin-names";

/** An urgent signal as a native notification shows it. The shape main takes on `urgentSignals.set`. */
export interface UrgentSignal {
  readonly signalId: string;
  /** The ref of the External Entity the signal is about, whose Inbox pane a click opens. */
  readonly ref: string;
  /** The notification's title: the signal's source, such as "GitHub". */
  readonly title: string;
  /** The notification's text: the signal's title. */
  readonly body: string;
}

/**
 * Returns the urgent signals among the open `signals` as their notifications
 * show them, the oldest first. Main notifies for each one it has not shown
 * yet, while the window is not focused.
 *
 * Only a signal about an External Entity is listed: its notification opens
 * the thing's pane on the Inbox. A signal with no entity has no place in the
 * app to open, so it shows no notification; `hercule signal list` still
 * lists it.
 *
 * Only a plugin's kind may be `urgent` (spec 10 §9.3), so each title is a
 * plugin's name, and no workflow or assistant is needed to name it.
 */
export const listUrgentSignals = (
  signals: ReadonlyArray<Signal>,
  plugins: ReadonlyArray<PluginName>,
): ReadonlyArray<UrgentSignal> =>
  signals
    .filter((signal) => signal.priority === "urgent")
    .toSorted((a, b) => a.createdAt.localeCompare(b.createdAt))
    .flatMap((signal) => {
      // The entity is found by the signal's thread ref, so that ref is the thing's.
      if (signal.entity === undefined || signal.origin.type !== "event") return [];
      const pluginId = parsePluginId(signal.kind);
      return [
        {
          signalId: signal.id,
          ref: signal.origin.threadRef,
          title: pluginId === null ? CORE_SOURCE_NAME : namePlugin(pluginId, plugins),
          body: signal.title,
        },
      ];
    });
