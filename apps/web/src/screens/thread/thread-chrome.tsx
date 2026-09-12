import type { JSX, ReactNode } from "react";
import { cn } from "@hydra/ui";

/**
 * The thread's chrome: the one row spec 14 §The thread surface pins - the
 * project crumb, then the title, then the actions at the right. A thread
 * carries no project yet, so the crumb reads `Threads /` until one does.
 *
 * It belongs to the screen rather than to the shell: the shell's own title
 * would say the same thing one row higher.
 */
export function ThreadChrome({
  project,
  title,
  actions,
}: {
  readonly project: string | null;
  readonly title: string;
  readonly actions?: ReactNode;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2.5 px-6 pt-3 pb-2 text-[16px] font-emph text-ink">
      <span className="shrink-0 font-normal text-faint">{`${project ?? "Threads"} /`}</span>{" "}
      <span className="truncate">{title}</span>
      {actions === undefined ? null : (
        <span className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</span>
      )}
    </div>
  );
}

/** One action on that row. The chrome owns the look; the screen says what it does. */
export function ChromeAction(props: {
  readonly title: string;
  readonly disabled?: boolean;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      title={props.title}
      disabled={props.disabled}
      className="rounded-full border border-line bg-raised px-[11px] py-[3px] text-meta font-normal whitespace-nowrap text-muted enabled:cursor-pointer enabled:hover:bg-line-soft enabled:hover:text-ink"
    >
      {props.children}
    </button>
  );
}

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
