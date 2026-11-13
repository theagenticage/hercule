/**
 * What the Inbox pane draws for a group of linked things: the head's words,
 * each member with what it asks, and each linked pair with who says it is
 * linked. Each function returns finished words and values from the read of the
 * group (`externalEntity.readInboxGroup`), so the pane only draws them.
 */
import type { EntityPeer, EntityStatus, InboxGroupDetail, InboxThing } from "@hercule/contract";
import { readEntityPluginId } from "../desk/entity-words";
import { describeClaim } from "../desk/link-claim";
import { namePlugin, type PluginName } from "../intake";
import { decideReason, findRowHolder } from "./inbox-row";

/** One member of the group: the line it takes in the pane. */
export interface InboxGroupPaneMember {
  readonly ref: string;
  readonly pluginId: string;
  /** The title, or the noun ("Pull request") when the source shows none to the user. */
  readonly title: string;
  readonly identifier?: string | undefined;
  /** The status shape beside the second line, or `undefined` for a member with no status. */
  readonly status?: EntityStatus | undefined;
  /** The second line: the ask the member makes of the user, or else what it is. */
  readonly why: {
    /** The person the sentence starts with, drawn in ink. */
    readonly who?: string | undefined;
    readonly rest: string;
    /** How many more asks the member has, drawn as a "+1" chip; 0 for none. */
    readonly more: number;
    /** True when the member asks nothing of the user: the line is quiet. */
    readonly quiet: boolean;
  };
  /** What a screen reader says for the whole entry. */
  readonly label: string;
}

/** One end of a linked pair: its source's mark and its name, which is the identifier and else the title. */
export interface InboxGroupPaneEnd {
  readonly pluginId: string;
  readonly name: string;
  /** True when `name` is an identifier, which the pane never cuts. */
  readonly isIdentifier: boolean;
}

/** One linked pair and who says so. */
export interface InboxGroupPanePair {
  readonly fromRef: string;
  readonly toRef: string;
  readonly from: InboxGroupPaneEnd;
  readonly to: InboxGroupPaneEnd;
  /** Who links them, such as "Linear reports this" or "You linked these". */
  readonly claim: string;
  /** True when the user claims the pair, so the pane offers Unlink on it. */
  readonly canUnlink: boolean;
}

/** Everything the pane of a group draws below its head. */
export interface InboxGroupPaneView {
  readonly title: string;
  /** "2 of them wait on you", or "Nothing in it waits on you". */
  readonly waiting: string;
  readonly members: readonly InboxGroupPaneMember[];
  readonly pairs: readonly InboxGroupPanePair[];
  /** True when the group has more members or links than the read lists. */
  readonly isCut: boolean;
}

/** What `describeInboxGroupPane` needs besides the group. */
export interface InboxGroupPaneContext {
  readonly plugins: ReadonlyArray<PluginName>;
  /** The rows the Inbox holds, by reference. A member with a row says its ask; one without says what it is. */
  readonly rows: ReadonlyMap<string, InboxThing>;
  readonly userName: string;
  readonly now: Date;
}

/** Returns whether the row is an ask the user is to answer: it asks and no Task holds it. */
const isWaitingOnUser = (row: InboxThing | undefined): row is InboxThing =>
  row !== undefined && row.askCount > 0 && row.taskId === undefined;

/**
 * Returns the head's words for the group: "Linked · 4 things in Linear,
 * GitHub, Slack". The sources are named once each, in the order of their first
 * member.
 */
export const describeInboxGroupHead = (
  detail: Pick<InboxGroupDetail, "members">,
  plugins: ReadonlyArray<PluginName>,
): string => {
  const sources = [
    ...new Set(
      detail.members.map((member) => namePlugin(readEntityPluginId(member.kind), plugins)),
    ),
  ];
  return `Linked · ${String(detail.members.length)} things in ${sources.join(", ")}`;
};

const buildMember = (
  peer: EntityPeer,
  row: InboxThing | undefined,
  context: InboxGroupPaneContext,
): InboxGroupPaneMember => {
  const title = peer.title ?? peer.noun;
  const why: InboxGroupPaneMember["why"] =
    row === undefined
      ? { rest: peer.status?.label ?? peer.noun, more: 0, quiet: true }
      : decideReason(row, context, findRowHolder(row, context.userName));
  return {
    ref: peer.ref,
    pluginId: readEntityPluginId(peer.kind),
    title,
    identifier: peer.identifier,
    status: peer.status,
    why: { who: why.who, rest: why.rest, more: why.more, quiet: why.quiet },
    label: `${title}. ${why.who === undefined ? "" : `${why.who} `}${why.rest}`,
  };
};

const buildEnd = (ref: string, peers: ReadonlyMap<string, EntityPeer>): InboxGroupPaneEnd => {
  const peer = peers.get(ref);
  const pluginId = readEntityPluginId(peer?.kind ?? ref);
  if (peer?.identifier !== undefined)
    return { pluginId, name: peer.identifier, isIdentifier: true };
  return { pluginId, name: peer?.title ?? peer?.noun ?? ref, isIdentifier: false };
};

/**
 * Returns what the pane draws for `detail`.
 *
 * - Members that wait on the user come first, longest wait first, then the
 *   others in the order the read lists them.
 * - A member's second line is its ask when the Inbox holds a row for it, else
 *   its status, else its noun.
 * - A pair names each end by identifier, else title. Its claim is the
 *   firmest one, worded as for a link elsewhere, except that a person's claim
 *   reads "You linked these" because a pair has two ends.
 */
export const describeInboxGroupPane = (
  detail: InboxGroupDetail,
  context: InboxGroupPaneContext,
): InboxGroupPaneView => {
  const peers = new Map(detail.members.map((peer) => [peer.ref, peer]));
  const waitingSince = (ref: string): string => context.rows.get(ref)?.waitingSince ?? "";
  const ordered = detail.members.toSorted((a, b) => {
    const isA = isWaitingOnUser(context.rows.get(a.ref));
    const isB = isWaitingOnUser(context.rows.get(b.ref));
    if (isA !== isB) return isA ? -1 : 1;
    return isA ? waitingSince(a.ref).localeCompare(waitingSince(b.ref)) : 0;
  });
  const waitingCount = detail.members.filter((peer) =>
    isWaitingOnUser(context.rows.get(peer.ref)),
  ).length;
  return {
    title: detail.label,
    waiting:
      waitingCount === 0
        ? "Nothing in it waits on you"
        : `${String(waitingCount)} of them ${waitingCount === 1 ? "waits" : "wait"} on you`,
    members: ordered.map((peer) => buildMember(peer, context.rows.get(peer.ref), context)),
    pairs: detail.links.map((link) => ({
      fromRef: link.fromRef,
      toRef: link.toRef,
      from: buildEnd(link.fromRef, peers),
      to: buildEnd(link.toRef, peers),
      claim:
        link.claim.type === "person"
          ? "You linked these"
          : describeClaim(link.claim, context.plugins),
      canUnlink: link.hasPersonClaim,
    })),
    isCut: !detail.complete,
  };
};
