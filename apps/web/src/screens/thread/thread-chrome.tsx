import type { JSX, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { ThreadTab } from "@hercule/client-core";
import { DoneMark, WorkingMark, cn } from "@hercule/ui";
import { HeaderRow } from "../header-row";

/**
 * Renders the thread's header row: the project crumb, then the title, then
 * the actions on the right. A thread with no
 * project shows `Threads /` as its crumb. An assistant's session shows
 * `Assistants / <name> /`, the name linking to the assistant's conversation.
 *
 * When the thread's workspace holds more than one thread, the title becomes
 * the active tab, with the other threads beside it in the workspace's order.
 * The workspace name is not repeated here, because the lip already shows it.
 *
 * The thread screen draws this row instead of the shell's top bar, because
 * the shell's title would repeat the same information one row higher. Spec 14
 * §The thread surface owns the row.
 */
export function ThreadChrome({
  crumb,
  title,
  tabs = [],
  actions,
}: {
  /** The project's name, or the assistant's crumb; the crumb shows `Threads` when undefined. */
  readonly crumb?: ReactNode;
  readonly title: string;
  readonly tabs?: readonly ThreadTab[];
  readonly actions?: ReactNode;
}): JSX.Element {
  return (
    <HeaderRow
      crumb={crumb ?? "Threads"}
      title={
        tabs.length === 0 ? (
          // A thread's title is its first message, which can be long, so it
          // is cut to one line, with the full text in a tooltip.
          <span title={title} className="min-w-0 truncate">
            {title}
          </span>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5">
            {tabs.map((tab) => (
              <Tab key={tab.sessionId ?? "draft"} tab={tab} />
            ))}
          </span>
        )
      }
      actions={actions}
    />
  );
}

/** One thread's tab in the header. The active tab is not a link. */
function Tab({ tab }: { readonly tab: ThreadTab }): JSX.Element {
  const body = (
    <>
      <span className="flex w-3 shrink-0 justify-center">
        {tab.mark === "working" ? (
          <WorkingMark />
        ) : tab.mark === "exited" ? (
          <DoneMark />
        ) : tab.mark === "draft" ? (
          // The draft mark, the same one the sidebar's draft row shows.
          <span aria-hidden="true" className="text-faint">
            ·
          </span>
        ) : (
          <span className="size-1.5 rounded-full border-[1.5px] border-faint" />
        )}
      </span>
      <span className="min-w-0 truncate">{tab.title}</span>
    </>
  );
  const shape = cn(
    "flex min-w-0 items-center gap-1.5 rounded-[8px] px-2.5 py-[3px] text-body tracking-normal",
    tab.active
      ? "border border-line bg-raised font-emph text-ink shadow-card"
      : "font-normal text-muted hover:text-ink",
  );

  if (tab.active || tab.sessionId === null) return <span className={shape}>{body}</span>;
  return (
    <Link to="/threads/$sessionId" params={{ sessionId: tab.sessionId }} className={shape}>
      {body}
    </Link>
  );
}

/** A button in the header row. This component sets the look; the screen supplies the behaviour. */
export function ChromeAction(props: {
  readonly title: string;
  readonly disabled?: boolean;
  /** Whether the content is a glyph rather than a word: narrower padding, wider letter spacing. */
  readonly icon?: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      title={props.title}
      disabled={props.disabled}
      className={cn(
        ACTION,
        "enabled:cursor-pointer enabled:hover:bg-line-soft enabled:hover:text-ink",
        // A button that cannot be used loses its lit fill and its label fades,
        // so it no longer reads as something to press.
        "disabled:cursor-not-allowed disabled:bg-transparent disabled:text-faint",
        props.icon ? "px-[9px] tracking-[1px]" : "px-[11px]",
      )}
    >
      {props.children}
    </button>
  );
}

/**
 * The New thread here link: starts another thread in the same workspace. A
 * thread without a workspace, or in one that is not ready, does not show it.
 */
export function NewThreadHere({
  projectId,
  workspaceId,
}: {
  /** Null when the workspace belongs to no project. */
  readonly projectId: string | null;
  readonly workspaceId: string;
}): JSX.Element {
  return (
    <Link
      to="/threads/new"
      search={{
        ...(projectId === null ? {} : { project: projectId }),
        workspace: workspaceId,
      }}
      className={cn(ACTION, "px-[11px] hover:bg-line-soft hover:text-ink")}
    >
      + New thread here
    </Link>
  );
}

const ACTION =
  "rounded-full border border-line bg-raised py-[3px] text-meta font-normal whitespace-nowrap text-muted";
