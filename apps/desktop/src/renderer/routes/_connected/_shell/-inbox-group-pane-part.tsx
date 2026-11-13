import { useMemo, type JSX } from "react";
import { keepPreviousData, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import { readErrorMessage, type HerculeClient } from "@hercule/client-core";
import { describeInboxGroupHead, describeInboxGroupPane } from "@hercule/client-core/inbox";
import { inboxGroupQuery, pluginsQuery, userQuery } from "../../../app/queries";
import {
  InboxGroupHead,
  InboxGroupPane,
  type UnlinkedEnd,
} from "../../../screens/inbox/inbox-group-pane";
import { InboxPaneSkeleton } from "../../../screens/inbox/inbox-states";
import { useInboxNow } from "./-inbox-clock";
import { useRestedThing } from "./-use-rested-thing";
import type { InboxListRow } from "./-inbox-visit";

/** The moves of the open group, which the screen decides what to do with. */
export interface InboxGroupPaneMoves {
  /** Shows the member `ref`, as the pane of its own thing. */
  readonly onWalkTo: (ref: string) => void;
  /** Removes the link the user made between the two ends of a pair. */
  readonly onUnlink: (first: UnlinkedEnd, second: UnlinkedEnd) => void;
  readonly onTakeOn: () => void;
  /** Starts the search for a thing to link to the group. */
  readonly onLink: () => void;
  readonly onDismiss: () => void;
}

/**
 * Renders the line at the start of the pane's head while a group shows: the
 * link glyph and "Linked · 4 things in Linear, GitHub". It reads the group
 * (the same read as `InboxGroupPanePart`, which shares it) once the group has
 * been current for a moment, so stepping down the list reads no group the
 * user does not stop on, and says only "Linked" until the read answers. With
 * `isActive` false (the pane lies over the list and is closed) nothing is read.
 */
export function InboxGroupHeadPart({
  client,
  memberRef,
  isActive,
}: {
  readonly client: HerculeClient;
  /** The reference of any thing of the group. */
  readonly memberRef: string;
  readonly isActive: boolean;
}): JSX.Element {
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const isRested = useRestedThing(memberRef, isActive);
  const group = useQuery({
    ...inboxGroupQuery(client, memberRef),
    enabled: isRested,
    placeholderData: keepPreviousData,
  });
  return (
    <InboxGroupHead
      words={group.data === undefined ? "Linked" : describeInboxGroupHead(group.data, plugins)}
    />
  );
}

/**
 * Renders the pane of the group the thing `memberRef` is in: its members and how
 * they are linked, over the footer with the moves that work.
 *
 * It reads the group whole (`externalEntity.readInboxGroup`), under the key a
 * push on the Inbox reads again, so a link or an unlink redraws it. A member's
 * ask comes from `rows`, the rows the Inbox holds by reference; a member with
 * no row there shows its status. It shows quiet shapes while the first read is
 * on its way, and says why when it fails. The read waits until the group has
 * been current for a moment, as the pane of a thing does, so stepping down the
 * list reads no group the user does not stop on. With `isActive` false (the
 * pane lies over the list and is closed) nothing is read.
 *
 * Stepping to a thing of another group keeps the group before drawn, inert,
 * until the read answers.
 *
 * Orchestrating: it owns the read of the group.
 */
export function InboxGroupPanePart({
  client,
  memberRef,
  rows,
  isActive,
  moves,
}: {
  readonly client: HerculeClient;
  /** The reference of any thing of the group. */
  readonly memberRef: string;
  readonly rows: ReadonlyMap<string, InboxListRow>;
  readonly isActive: boolean;
  readonly moves: InboxGroupPaneMoves;
}): JSX.Element {
  const { data: plugins } = useSuspenseQuery(pluginsQuery(client));
  const { username } = useSuspenseQuery(userQuery(client)).data;
  const isRested = useRestedThing(memberRef, isActive);
  const group = useQuery({
    ...inboxGroupQuery(client, memberRef),
    enabled: isRested,
    placeholderData: keepPreviousData,
  });
  const detail = group.data;
  // One array while the group and the rows stay the same, so the clock does not set its timer again on every render.
  const heldMembers = useMemo(
    () =>
      detail === undefined
        ? []
        : detail.members.flatMap((peer) => {
            const row = rows.get(peer.ref);
            return row === undefined ? [] : [row];
          }),
    [detail, rows],
  );
  const now = useInboxNow(heldMembers);
  if (detail === undefined) {
    return group.isError ? (
      <p className="ib-pane-blocks-note">
        {`This group could not be read. ${readErrorMessage(group.error)}`}
      </p>
    ) : (
      <InboxPaneSkeleton />
    );
  }
  const view = describeInboxGroupPane(detail, { plugins, rows, userName: username, now });
  return (
    <div
      className="ib-pane-content"
      aria-busy={group.isPlaceholderData ? "true" : undefined}
      inert={group.isPlaceholderData}
    >
      <InboxGroupPane
        view={view}
        plugins={plugins}
        onWalkTo={moves.onWalkTo}
        onUnlink={moves.onUnlink}
        onTakeOn={moves.onTakeOn}
        onLink={moves.onLink}
        onDismiss={moves.onDismiss}
      />
    </div>
  );
}
