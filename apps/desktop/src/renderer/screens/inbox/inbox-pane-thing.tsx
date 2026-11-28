import type { JSX, ReactNode, Ref } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import type {
  PaneHistoryLine,
  PaneLink,
  PaneMetaItem,
  PaneTaskStrip,
} from "@hercule/client-core/inbox";
import { buildLook, Face } from "../../faces";
import { TasksIcon } from "../../icons/tasks";
import { PluginMark } from "../../marks";
import { EntityStatusIcon } from "../desk/status-shape";
import { CardFactText } from "./card-parts";
import "./inbox-pane-thing.css";

/**
 * What the pane shows of the plugin's blocks:
 * - `loading`: quiet shapes while they are read;
 * - `failed`: one line, `words`, such as "GitHub couldn't be read just now.";
 * - `ready`: the drawn blocks, `content`, in a slot that is left out when empty.
 */
export type InboxPaneBlocks =
  | { readonly state: "loading" }
  | { readonly state: "failed"; readonly words: string }
  | { readonly state: "ready"; readonly content: ReactNode };

/**
 * Renders the strip of the Task the thing is on: the face of the first
 * workflow running on it, or the Task mark when none runs, the Task's title,
 * what runs on it, and View task.
 */
function InboxPaneTask({
  task,
  onViewTask,
}: {
  readonly task: PaneTaskStrip;
  readonly onViewTask: () => void;
}): JSX.Element {
  const { faceSeed } = task;
  return (
    <div className="ib-pane-task">
      <span className="ib-pane-task-mark">
        {faceSeed === undefined ? (
          <TasksIcon size={16} />
        ) : (
          <Face look={buildLook(faceSeed)} pose="working" size={22} />
        )}
      </span>
      <span className="ib-pane-task-words">
        <b>{task.title}</b>
        {task.activity}
      </span>
      <button type="button" className="btn btn--sm" aria-keyshortcuts="G" onClick={onViewTask}>
        View task
        <kbd aria-hidden="true">G</kbd>
      </button>
    </div>
  );
}

/** Renders the plugin's blocks, or the line or shapes that stand for them. Draws nothing for no blocks. */
function InboxPaneBlockSlot({ blocks }: { readonly blocks: InboxPaneBlocks }): JSX.Element | null {
  if (blocks.state === "loading") {
    return (
      <div className="ib-pane-blocks ib-pane-blocks-skel" aria-hidden="true">
        <i style={{ width: "100%" }} />
        <i style={{ width: "86%" }} />
        <i style={{ width: "52%" }} />
      </div>
    );
  }
  if (blocks.state === "failed") {
    return <p className="ib-pane-blocks ib-pane-blocks-note">{blocks.words}</p>;
  }
  if (blocks.content === null || blocks.content === undefined || blocks.content === false) {
    return null;
  }
  return <div className="ib-pane-blocks">{blocks.content}</div>;
}

/**
 * Renders the pane's content for one thing, to sit above its footer: its
 * title with the identifier after it, the meta line, the Task it is on, then the
 * asks and the blocks, what is linked to it and what happened.
 *
 * - `meta` is the meta line, item by item in the order shown. The separators
 *   between items are drawn by CSS, so no item starts with a dot and a wrapped
 *   line never starts or ends with one.
 * - `task` is the strip of the Task the thing is on, or `undefined` when it
 *   is on none. `onViewTask` is called by its View task button.
 * - `asks` holds the signal sections and is drawn first, then `blocks`.
 * - `links` is the Linked section, left out when empty.
 * - `history` is What happened, newest first, left out when empty.
 * - `onGoTo` is called with a linked thing's reference when its title is pressed.
 * - `ref` is the element that scrolls, which the keys scroll by a page.
 *
 * Every word comes in as a prop; the component decides nothing.
 */
export function InboxPaneThing({
  title,
  identifier,
  meta,
  task,
  asks,
  blocks,
  links,
  history,
  plugins,
  ref,
  onViewTask,
  onGoTo,
}: {
  readonly title: string;
  readonly identifier?: string | undefined;
  readonly meta: ReadonlyArray<PaneMetaItem>;
  readonly task?: PaneTaskStrip | undefined;
  readonly asks: ReactNode;
  readonly blocks: InboxPaneBlocks;
  readonly links: ReadonlyArray<PaneLink>;
  readonly history: ReadonlyArray<PaneHistoryLine>;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly ref?: Ref<HTMLDivElement>;
  readonly onViewTask: () => void;
  readonly onGoTo: (ref: string) => void;
}): JSX.Element {
  const hasAsks = asks !== null && asks !== undefined && asks !== false;
  return (
    <div ref={ref} className="ib-pane-scroll">
      <h2 className="ib-pane-title">
        {title}
        {identifier === undefined || identifier === "" ? null : (
          <>
            {" "}
            <span className="ib-pane-id">{identifier}</span>
          </>
        )}
      </h2>
      {meta.length > 0 && (
        <p className="ib-pane-meta">
          {meta.map((item, index) => (
            <span key={index}>
              {item.kind === "status" ? (
                <>
                  <EntityStatusIcon status={item.status} size={14} />
                  {item.status.label}
                </>
              ) : item.kind === "fact" ? (
                <CardFactText fact={item.fact} />
              ) : (
                item.words
              )}
            </span>
          ))}
        </p>
      )}
      {task === undefined ? null : <InboxPaneTask task={task} onViewTask={onViewTask} />}
      {hasAsks && <div className="ib-pane-asks">{asks}</div>}
      <InboxPaneBlockSlot blocks={blocks} />
      {links.length > 0 && (
        <section className="ib-pane-sec">
          <h3 className="ib-pane-h">Linked</h3>
          <ul className="ib-pane-links">
            {links.map((link) => (
              <li key={link.ref} className="ib-pane-link">
                <PluginMark pluginId={link.pluginId} plugins={plugins} size={14} />
                <button
                  type="button"
                  className="ib-pane-link-title"
                  onClick={() => {
                    onGoTo(link.ref);
                  }}
                >
                  {link.title}
                </button>
                <span className="ib-pane-link-id">{link.identifier}</span>
                <span className="ib-pane-link-claim">{link.claim}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {history.length > 0 && (
        <section className="ib-pane-sec">
          <h3 className="ib-pane-h">What happened</h3>
          <ol className="ib-pane-history">
            {history.map((line, index) => (
              <li key={index}>
                <time>{line.when}</time>
                <span>{line.sentence}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
