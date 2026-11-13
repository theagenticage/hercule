import { useEffect, useRef, type JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import { CloseIcon } from "../../icons/close";
import { PluginMark } from "../../marks";
import { playChipsArriving } from "./thread-dialog-motion";
import "./thread-dialog.css";

/** The size of a source's mark on a chip, in pixels. */
const MARK_SIZE = 12;

/** One thing the thread starts from, as a chip draws it. */
export interface ThingChip {
  readonly id: string;
  /** The plugin the thing comes from, which decides its mark. */
  readonly pluginId: string;
  /** The thing's identifier in its source, such as `SHOP-142`, or `null` when it has none. */
  readonly identifier: string | null;
  readonly title: string;
}

/**
 * Renders the things a thread starts from as chips: the source's mark, the
 * identifier in bold, then the title, cut with an ellipsis when it is long.
 * It is drawn inside the composer, above the message field, because the things
 * travel with the message as prompt attachments.
 *
 * Each chip has a button "Leave <identifier> out" that calls `onRemove` with
 * the thing's id. The last chip has none: a thread needs at least one thing.
 * `plugins` is the plugin list the marks are found in. The chips arrive one
 * after another when the dialog opens.
 */
export function ThingChips({
  things,
  plugins,
  onRemove,
}: {
  readonly things: readonly ThingChip[];
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly onRemove: (id: string) => void;
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Only on mount: a chip that is left out must not make the others arrive again.
    playChipsArriving([...(listRef.current?.children ?? [])]);
  }, []);
  const removable = things.length > 1;
  return (
    <div ref={listRef} className="thread-dialog-chips">
      {things.map((thing) => (
        <span key={thing.id} className="thread-dialog-chip" title={thing.title}>
          <PluginMark pluginId={thing.pluginId} plugins={plugins} size={MARK_SIZE} />
          {thing.identifier === null ? null : <b>{thing.identifier}</b>}
          <span className="thread-dialog-chip-title">{thing.title}</span>
          {removable ? (
            <button
              type="button"
              aria-label={`Leave ${thing.identifier ?? thing.title} out`}
              onClick={() => {
                onRemove(thing.id);
              }}
            >
              <CloseIcon size={10} />
            </button>
          ) : null}
        </span>
      ))}
    </div>
  );
}
