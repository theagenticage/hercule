import type { JSX, ReactNode, Ref } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  buildSiblingTabs,
  describeStartingRun,
  findAnsweredAssistantId,
  isJoinable,
  isSubagentWaiting,
  listSubagentAncestors,
  nameSubagent,
  type HerculeClient,
  type ThreadTab,
} from "@hercule/client-core";
import type { Session, Subagent } from "@hercule/contract";
import { DoneMark, WorkingMark, cn, useElementWidth } from "@hercule/ui";
import { projectsQuery, sessionsQuery, workspacesQuery } from "../../app/queries";
import { HeaderRow } from "../header-row";
import { SubagentMark } from "../subagents/subagent-mark";
import { togglePane, useSidePaneLayout } from "../subagents/use-side-pane";
import { AssistantCrumb } from "./assistant-crumb";
import { StepSessionCrumb } from "./step-session-crumb";

/**
 * The header row's width, in pixels, below which "+ New thread here" shrinks
 * to "+". At 1280px with the side pane open the row is about 560px wide, and
 * the full button would leave the title little room.
 */
const COMPACT_ROW_WIDTH = 640;

/**
 * Renders the header row of one agent's page: the session's own agent's page
 * when `subagent` is undefined, else that subagent's.
 *
 * - On the session's own agent's page, it reads the thread's project and the
 *   other threads in its workspace, which the header shows beside the title.
 *   The crumb is the assistant for an assistant's session, the run for a step
 *   session, and the project otherwise.
 * - On a subagent's page, the crumb runs from the thread down through the
 *   subagent's ancestors, and the title is the subagent's mark and name with
 *   an uppercase SUBAGENT label.
 *
 * Both end with the side pane's toggle.
 */
export function AgentChrome({
  client,
  session,
  subagents,
  subagent,
}: {
  readonly client: HerculeClient;
  readonly session: Session;
  /** Every subagent of the session, oldest first. */
  readonly subagents: readonly Subagent[];
  /** The subagent whose page this is; undefined on the thread's own page. */
  readonly subagent: Subagent | undefined;
}): JSX.Element {
  return subagent === undefined ? (
    <SessionAgentChrome client={client} session={session} />
  ) : (
    <SubagentChrome session={session} subagents={subagents} subagent={subagent} />
  );
}

/**
 * Renders the header row of the session's own agent's page. As the row gets
 * narrower, it gives way in this order: "+ New thread here" shrinks to "+",
 * then the other threads' tabs truncate, then the title truncates.
 */
function SessionAgentChrome({
  client,
  session,
}: {
  readonly client: HerculeClient;
  readonly session: Session;
}): JSX.Element {
  const projects = useQuery(projectsQuery(client)).data?.items ?? [];
  const workspaces = useQuery(workspacesQuery(client)).data?.items ?? [];
  const sessions = useQuery(sessionsQuery(client)).data?.items ?? [];
  const workspace = workspaces.find((each) => each.id === session.workspaceId);
  const project = projects.find((each) => each.id === session.projectId);
  const assistantId = findAnsweredAssistantId(session);
  // A step session's crumb names the run that started it.
  const startingRun = describeStartingRun(session);
  // Decided on the row's own width, not the window's: the side pane and the
  // sidebar take their share of the window first. An unmeasured row counts
  // as wide.
  const { observeElement, width } = useElementWidth();
  const compact = width !== undefined && width < COMPACT_ROW_WIDTH;

  return (
    <ThreadChrome
      rowRef={observeElement}
      crumb={
        assistantId !== null ? (
          <AssistantCrumb client={client} assistantId={assistantId} />
        ) : session.runId !== null && startingRun !== undefined ? (
          <StepSessionCrumb runId={session.runId} label={startingRun} />
        ) : (
          project?.name
        )
      }
      title={session.title}
      tabs={buildSiblingTabs({ workspace, sessions, activeSessionId: session.id })}
      actions={
        <>
          {workspace === undefined || !isJoinable(workspace) ? null : (
            <NewThreadHere
              projectId={session.projectId}
              workspaceId={workspace.id}
              compact={compact}
            />
          )}
          <ChromeAction title="More (not built)" icon disabled>
            …
          </ChromeAction>
          <PaneToggle />
        </>
      }
    />
  );
}

/**
 * Renders the header row of a subagent's page: the crumb from the thread
 * down through the subagent's ancestors, each a link to its page, then the
 * subagent's mark, its name and an uppercase SUBAGENT label. The page is
 * marked in words rather than colour, because the design language keeps
 * colour at word and mark scale.
 */
function SubagentChrome({
  session,
  subagents,
  subagent,
}: {
  readonly session: Session;
  readonly subagents: readonly Subagent[];
  readonly subagent: Subagent;
}): JSX.Element {
  const name = nameSubagent(subagent);
  return (
    <HeaderRow
      crumb={
        <>
          <Link
            to="/threads/$sessionId"
            params={{ sessionId: session.id }}
            title={session.title}
            className={CRUMB_LINK}
          >
            {session.title}
          </Link>
          {listSubagentAncestors(subagent, subagents).map((ancestor) => (
            <span key={ancestor.id} className="flex items-center gap-2">
              <span aria-hidden="true">/</span>{" "}
              <Link
                to="/threads/$sessionId/subagents/$subagentId"
                params={{ sessionId: session.id, subagentId: ancestor.id }}
                title={nameSubagent(ancestor)}
                className={CRUMB_LINK}
              >
                {nameSubagent(ancestor)}
              </Link>
            </span>
          ))}
        </>
      }
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="flex w-3 shrink-0 justify-center">
            <SubagentMark
              status={subagent.status}
              waiting={isSubagentWaiting(subagent, session.openRequests)}
            />
          </span>
          <span title={name} className="min-w-0 truncate">
            {name}
          </span>
          <span className="shrink-0 text-label font-emph tracking-[0.1em] text-faint uppercase">
            Subagent
          </span>
        </span>
      }
      actions={<PaneToggle />}
    />
  );
}

/** One link of a subagent page's crumb, cut short so a deep chain still fits. */
const CRUMB_LINK =
  "inline-block max-w-[120px] truncate rounded-control align-bottom hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live";

/**
 * Renders the thread's header row: the project crumb, then the title, then
 * the actions on the right. A thread with no project shows `Threads /` as its
 * crumb. An assistant's session shows `Assistants / <name> /`, the name
 * linking to the assistant's conversation. A step session shows
 * `run 3db7d6bb /`, linking to the run.
 *
 * When the thread's workspace holds more than one thread, the title becomes
 * the active tab, with the other threads beside it in the workspace's order.
 * When the row runs short of room, the other threads' tabs shrink first, down
 * to their mark, and only then the active one. The workspace name is not
 * repeated here, because the lip already shows it.
 *
 * The thread's page and the draft thread screen draw this row instead of the
 * shell's top bar, because the shell's title would repeat the same
 * information one row higher. Spec 14
 * §The thread surface owns the row.
 */
export function ThreadChrome({
  crumb,
  title,
  tabs = [],
  actions,
  rowRef,
}: {
  /** The project's name, or an assistant's or a step session's crumb; the crumb shows `Threads` when undefined. */
  readonly crumb?: ReactNode;
  readonly title: string;
  readonly tabs?: readonly ThreadTab[];
  readonly actions?: ReactNode;
  /** Receives the row's element, for a caller that lays the row out by its width. */
  readonly rowRef?: Ref<HTMLDivElement> | undefined;
}): JSX.Element {
  return (
    <HeaderRow
      rowRef={rowRef}
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

/**
 * One thread's tab in the header. The active tab is not a link. The other
 * tabs shrink far faster than the active one, so they give up their room
 * first, down to their mark and an ellipsis.
 */
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
    "flex items-center gap-1.5 rounded-[8px] px-2.5 py-[3px] text-body tracking-normal",
    tab.active
      ? "min-w-0 border border-line bg-raised font-emph text-ink shadow-card"
      : "min-w-14 shrink-[1000] font-normal text-muted hover:text-ink",
  );

  if (tab.active || tab.sessionId === null) {
    return (
      <span title={tab.title} className={shape}>
        {body}
      </span>
    );
  }
  return (
    <Link
      to="/threads/$sessionId"
      params={{ sessionId: tab.sessionId }}
      title={tab.title}
      className={shape}
    >
      {body}
    </Link>
  );
}

/**
 * Renders the header's toggle for the side pane, in the shape of the
 * header's other actions. Opening a pane that holds no surface opens it on
 * Subagents.
 */
function PaneToggle(): JSX.Element {
  const { layout, changeLayout } = useSidePaneLayout();
  const label = layout.open ? "Hide the side pane" : "Show the side pane";
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={layout.open}
      onClick={() => {
        changeLayout(togglePane);
      }}
      className={cn(
        ACTION,
        "box-content flex h-[1lh] cursor-pointer items-center px-[9px] hover:bg-line-soft hover:text-ink",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
        layout.open && "text-ink",
      )}
    >
      <svg
        viewBox="0 0 12 12"
        className="size-3"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.15}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x={1.5} y={2} width={9} height={8} rx={1.5} />
        <path d="M7.5 2v8" />
        {layout.open ? <path d="M8.6 4.2h.9M8.6 6h.9" /> : null}
      </svg>
    </button>
  );
}

/** A button in the header row. This component sets the look; the screen supplies the behaviour. */
function ChromeAction(props: {
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
 * In a narrow header it shows only "+", and keeps its words in its tooltip
 * and its accessible name.
 */
function NewThreadHere({
  projectId,
  workspaceId,
  compact = false,
}: {
  /** Null when the workspace belongs to no project. */
  readonly projectId: string | null;
  readonly workspaceId: string;
  readonly compact?: boolean;
}): JSX.Element {
  return (
    <Link
      to="/threads/new"
      search={{
        ...(projectId === null ? {} : { project: projectId }),
        workspace: workspaceId,
      }}
      title={compact ? "New thread here" : undefined}
      aria-label={compact ? "New thread here" : undefined}
      className={cn(
        ACTION,
        compact ? "px-[9px]" : "px-[11px]",
        "hover:bg-line-soft hover:text-ink",
        "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
      )}
    >
      {compact ? "+" : "+ New thread here"}
    </Link>
  );
}

const ACTION =
  "rounded-full border border-line bg-raised py-[3px] text-meta font-normal whitespace-nowrap text-muted";
