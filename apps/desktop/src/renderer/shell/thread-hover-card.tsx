/**
 * The card of details that shows beside the sidebar while the pointer rests
 * on a group's row: the lead's full title, its project, its machine, its
 * branch and its model, as T3 Code's sidebar shows them. For a group of
 * several sessions, a list of the sessions replaces the model: each one's
 * mark, name, agent and status.
 *
 * The list draws one card for all its rows. The card is a popover, so it
 * sits in the top layer above the main pane, and the sidebar's scrolling
 * box does not clip it. It only shows details: it takes no pointer events
 * and no focus, and is hidden from assistive technology, because each row's
 * accessible description already carries the same details.
 */
import { useId, useLayoutEffect, useRef, type JSX, type ReactNode } from "react";
import type { GroupMember, SessionDot } from "@hercule/client-core";
import { BranchIcon } from "../icons/branch";
import { LaptopIcon } from "../icons/laptop";
import { ProjectTile, type ProjectTint } from "../screens/project-tile";
import { ProviderLogo } from "../screens/thread/provider-logo";
import { AgentLabel, SessionMark, StatusSlot } from "./sidebar-rows";
import "./thread-hover-card.css";

/** What the card shows about one group of sessions, or about one thread. */
export interface ThreadHoverDetails {
  /** The title of the group's lead, in full. */
  readonly title: string;
  /** The project's name, or "No project". */
  readonly projectName: string;
  /** The project's tint, or `null` for a thread in no project, whose tile is an outline. */
  readonly tint: ProjectTint | null;
  /** The name of the machine the thread runs on, or `null` when it has none. */
  readonly machine: string | null;
  /** The branch the thread works on, or `null` when it works on none. */
  readonly branch: string | null;
  /** The model's name, or `null` when it is not known. */
  readonly model: string | null;
  /** The id of the model's provider, whose mark shows before the model's name. */
  readonly providerId: string | null;
  /** The sessions of a group of several, or none for a thread alone, whose card shows its model instead. */
  readonly members: readonly GroupMember[];
}

/** Where the card shows, and for which row. */
export interface ThreadHoverPlacement {
  /** The `data-key` of the thread row the card shows beside. */
  readonly key: string;
  /** The card's left edge, in CSS pixels from the window's left edge. */
  readonly left: number;
  /** Where the card's top edge goes, in CSS pixels from the window's top, before it is kept inside the window. */
  readonly top: number;
}

/** The space the card keeps from the window's top and bottom edges, in CSS pixels. */
const WINDOW_MARGIN = 8;

/** The size of each row's icon, in CSS pixels. */
const ICON_SIZE = 12;

/** How many sessions the card lists before it folds the rest into "and n more". */
const MEMBER_LIMIT = 8;

/** Returns how urgent a session's dot is, lowest first: waiting, then working, then quiet. */
const rankDot = (dot: SessionDot): number => (dot === "waiting" ? 0 : dot === "working" ? 1 : 2);

/** Renders one line of the card: an icon, then the text beside it. */
function DetailRow({
  icon,
  children,
}: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="thread-hover-row">
      <span className="thread-hover-icon">{icon}</span>
      <span className="thread-hover-text">{children}</span>
    </div>
  );
}

/** Renders one session of a group in the card: its mark, its name in the group, its agent and its status. */
function MemberRow({ member }: { readonly member: GroupMember }): JSX.Element {
  const statusId = useId();
  return (
    <div className="thread-hover-member">
      <SessionMark dot={member.dot} done={member.done} />
      <span className="thread-hover-member-name">{member.label}</span>
      <AgentLabel providerId={member.providerId} model={member.model} />
      <StatusSlot id={statusId} status={member.status} activityAt={member.activityAt} onScreen />
    </div>
  );
}

/**
 * Renders the card of `details`, shown at `placement`, or hidden while
 * `placement` is `null`. The machine, the branch and the model each have a
 * row only when they are known. A group of several sessions lists them, the
 * most urgent first and eight at most, instead of its lead's model. When the
 * row `unfolds`, the card ends with the hint that says how.
 *
 * The card's top is moved up when the card would reach past the window's
 * bottom edge, so a card for a row near the bottom stays in view. The card
 * lays itself out only when `placement` changes, not when `details` does.
 */
export function ThreadHoverCard({
  placement,
  details,
  unfolds,
}: {
  readonly placement: ThreadHoverPlacement | null;
  readonly details: ThreadHoverDetails | null;
  readonly unfolds: boolean;
}): JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null);

  // Shown and placed before the browser paints, so the card never shows at
  // the place it had for the previous row. Its height is known only once it
  // shows, so the top is kept inside the window after that.
  useLayoutEffect(() => {
    const card = cardRef.current!;
    if (placement === null) {
      card.togglePopover(false);
      return;
    }
    card.style.left = `${String(placement.left)}px`;
    card.togglePopover(true);
    const lowestTop = window.innerHeight - WINDOW_MARGIN - card.offsetHeight;
    const top = Math.max(WINDOW_MARGIN, Math.min(placement.top, lowestTop));
    card.style.top = `${String(top)}px`;
  }, [placement]);

  const listed =
    details === null ? [] : details.members.toSorted((a, b) => rankDot(a.dot) - rankDot(b.dot));
  return (
    <div
      ref={cardRef}
      popover="manual"
      className={listed.length === 0 ? "thread-hover" : "thread-hover thread-hover--crew"}
      aria-hidden="true"
    >
      {details === null ? null : (
        <>
          <p className="thread-hover-title">{details.title}</p>
          <div className="thread-hover-row">
            <ProjectTile tint={details.tint} name={details.projectName} />
          </div>
          {details.machine === null ? null : (
            <DetailRow icon={<LaptopIcon size={ICON_SIZE} />}>{details.machine}</DetailRow>
          )}
          {details.branch === null ? null : (
            <DetailRow icon={<BranchIcon size={ICON_SIZE} />}>{details.branch}</DetailRow>
          )}
          {listed.length > 0 || details.model === null ? null : (
            <DetailRow
              icon={
                details.providerId === null ? null : (
                  <ProviderLogo providerId={details.providerId} size={ICON_SIZE} />
                )
              }
            >
              {details.model}
            </DetailRow>
          )}
          {listed.length === 0 ? null : (
            <>
              <div className="thread-hover-crew">
                {listed.slice(0, MEMBER_LIMIT).map((member) => (
                  <MemberRow key={member.sessionId} member={member} />
                ))}
                {listed.length > MEMBER_LIMIT ? (
                  <div className="thread-hover-more">{`and ${String(listed.length - MEMBER_LIMIT)} more`}</div>
                ) : null}
              </div>
              {unfolds ? (
                <p className="thread-hover-hint">Click the dots or press → to unfold</p>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}
