import type { JSX, ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import type { ThreadTab } from "@hercule/client-core";
import { DoneMark, WorkingMark, cn } from "@hercule/ui";

/**
 * The thread's chrome: the one row spec 14 §The thread surface pins - the
 * project crumb, then the title, then the actions at the right. A thread that
 * belongs to no project crumbs `Threads /`.
 *
 * When the thread's workspace holds more than one thread the title is the
 * active tab and its siblings sit beside it, in the workspace's own order; the
 * workspace's own name is not repeated here, because the lip has it.
 *
 * It belongs to the screen rather than to the shell: the shell's own title
 * would say the same thing one row higher.
 */
export function ThreadChrome({
  crumb,
  title,
  tabs = [],
  actions,
}: {
  /** The project the thread belongs to; `Threads` where it belongs to none. */
  readonly crumb?: string | undefined;
  readonly title: string;
  readonly tabs?: readonly ThreadTab[];
  readonly actions?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2.5 px-6 pt-3 pb-2 text-[16px] font-emph text-ink">
      <span className="shrink-0 font-normal text-faint">{crumb ?? "Threads"} /</span>{" "}
      {tabs.length === 0 ? (
        <span className="truncate">{title}</span>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5">
          {tabs.map((tab) => (
            <Tab key={tab.sessionId ?? "draft"} tab={tab} />
          ))}
        </span>
      )}
      {actions === undefined ? null : (
        <span className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</span>
      )}
    </div>
  );
}

/** One thread of the workspace, beside its siblings. The active one is not a link. */
function Tab({ tab }: { readonly tab: ThreadTab }): JSX.Element {
  const body = (
    <>
      <span className="flex w-3 shrink-0 justify-center">
        {tab.mark === "working" ? (
          <WorkingMark />
        ) : tab.mark === "exited" ? (
          <DoneMark />
        ) : tab.mark === "draft" ? (
          // The draft's own mark, as the sidebar's draft row carries it.
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
    "flex min-w-0 items-center gap-1.5 rounded-[8px] px-2.5 py-[3px] text-[14px]",
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

/** One action on that row. The chrome owns the look; the screen says what it does. */
export function ChromeAction(props: {
  readonly title: string;
  readonly disabled?: boolean;
  /** A glyph rather than a word: narrower, and its dots spaced out. */
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
        props.icon ? "px-[9px] tracking-[1px]" : "px-[11px]",
      )}
    >
      {props.children}
    </button>
  );
}

/**
 * The one action a thread in a workspace offers: another thread beside it, in
 * the same files. Absent on a workspace-less thread, which has no "here".
 */
export function NewThreadHere({
  projectId,
  workspaceId,
}: {
  /** Null on a thread in a workspace that belongs to no project. */
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

/** The column under the chrome: 800px centred, with the surface's own padding. */
export function ThreadColumn({
  className,
  children,
}: {
  readonly className?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-1 flex-col px-6 pt-2 pb-16">
      <div className={cn("mx-auto flex w-full max-w-[800px] flex-1 flex-col", className)}>
        {children}
      </div>
    </div>
  );
}
