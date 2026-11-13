import type { JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import type { InboxGroupPaneEnd, InboxGroupPaneView } from "@hercule/client-core/inbox";
import type { InboxThing } from "@hercule/contract";
import { LinkIcon } from "../../icons/link";
import { PluginMark } from "../../marks";
import { EntityStatusIcon } from "../desk/status-shape";
import {
  InboxPaneDismissButton,
  InboxPaneFootEnd,
  InboxPaneLinkButton,
  InboxPaneTakeOnButton,
} from "./inbox-pane-footer";
import "./inbox-group-pane.css";
import "./inbox-pane-head.css";
import "./inbox-pane-thing.css";
import "./inbox-selection-pane.css";

/** Renders the pane's head line while a group shows: the link glyph and `words`, "Linked · 4 things in Linear, GitHub". */
export function InboxGroupHead({ words }: { readonly words: string }): JSX.Element {
  return (
    <p className="ib-pane-source">
      <span className="ib-pane-source-mark">
        <LinkIcon size={14} />
      </span>
      <span className="ib-pane-source-words">{words}</span>
    </p>
  );
}

/** The two ends of a pair as the line about an unlink names them: by identifier, else by title. */
export type UnlinkedEnd = Pick<InboxThing, "ref" | "identifier" | "title">;

/** Returns `end` of the pair as what an unlink names it by. The pair knows the end's name, not both its identifier and title, so the name fills the one it is. */
const readUnlinkedEnd = (ref: string, end: InboxGroupPaneEnd): UnlinkedEnd =>
  end.isIdentifier
    ? { ref, identifier: end.name, title: "" }
    : { ref, identifier: "", title: end.name };

/** Renders one end of a pair: the source's mark, then the identifier (never cut) or else the title (cut with an ellipsis). */
function PairEnd({
  end,
  plugins,
}: {
  readonly end: InboxGroupPaneEnd;
  readonly plugins: ReadonlyArray<PluginIdentity>;
}): JSX.Element {
  return (
    <>
      <span className="ib-group-pair-mark">
        <PluginMark pluginId={end.pluginId} plugins={plugins} size={12} />
      </span>
      <span className={end.isIdentifier ? "ib-group-pair-id" : "ib-group-pair-title"}>
        {end.name}
      </span>
    </>
  );
}

/**
 * Renders the pane of a group of linked things, over its footer: the title,
 * how many of its members wait on the user, each member, and how they are
 * linked.
 *
 * - A member is a button that calls `onWalkTo` with its reference, so the pane
 *   walks to that thing.
 * - A pair names its two ends on one line and, on the line under it, who says
 *   they are linked. A pair the user claims has Unlink there, which calls
 *   `onUnlink` with the pair's two ends. It shows under the pointer or the
 *   focus and takes its room all the time, so nothing moves when it shows.
 * - `view.isCut` adds a line that says the group has more than it lists.
 * - The footer has Take on, Link and Dismiss. It has no hand-off: a group is
 *   more than one thing, and a hand-off takes one.
 *
 * Every word comes in as a prop; the component decides nothing.
 */
export function InboxGroupPane({
  view,
  plugins,
  onWalkTo,
  onUnlink,
  onTakeOn,
  onLink,
  onDismiss,
}: {
  readonly view: InboxGroupPaneView;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly onWalkTo: (ref: string) => void;
  readonly onUnlink: (first: UnlinkedEnd, second: UnlinkedEnd) => void;
  readonly onTakeOn: () => void;
  readonly onLink: () => void;
  readonly onDismiss: () => void;
}): JSX.Element {
  return (
    <>
      <div className="ib-pane-scroll">
        <h2 className="ib-pane-title" tabIndex={-1}>
          {view.title}
        </h2>
        <p className="ib-pane-meta">
          <span>{view.waiting}</span>
        </p>
        <section className="ib-pane-sec ib-pane-sec--first">
          <ul className="ib-pane-members">
            {view.members.map((member) => (
              <li key={member.ref}>
                <button
                  type="button"
                  className="ib-pane-member"
                  aria-label={member.label}
                  onClick={() => {
                    onWalkTo(member.ref);
                  }}
                >
                  <span className="ib-pane-member-mark">
                    <PluginMark pluginId={member.pluginId} plugins={plugins} size={14} />
                  </span>
                  <span className="ib-pane-member-title">{member.title}</span>
                  <span className="ib-pane-member-id">{member.identifier}</span>
                  <span className="ib-pane-member-glyph">
                    {member.status === undefined ? null : (
                      <EntityStatusIcon status={member.status} size={12} />
                    )}
                  </span>
                  <span className="ib-pane-member-why">
                    {member.why.who === undefined ? null : <b>{member.why.who} </b>}
                    {member.why.rest}
                    {member.why.more > 0 && (
                      <span
                        className="ib-pane-member-more"
                        title={`${String(member.why.more)} more on it`}
                      >
                        +{member.why.more}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="ib-pane-sec">
          <h3 className="ib-pane-h">How they are linked</h3>
          <ul className="ib-group-pairs">
            {view.pairs.map((pair) => (
              <li key={`${pair.fromRef}|${pair.toRef}`} className="ib-group-pair">
                <span className="ib-group-pair-line">
                  <PairEnd end={pair.from} plugins={plugins} />
                  <span className="ib-group-pair-dash" aria-hidden="true" />
                  <PairEnd end={pair.to} plugins={plugins} />
                </span>
                <span className="ib-group-pair-claim">
                  {pair.claim}
                  {pair.canUnlink && (
                    <button
                      type="button"
                      className="ib-group-unlink"
                      aria-label={`Unlink ${pair.from.name} and ${pair.to.name}`}
                      onClick={() => {
                        onUnlink(
                          readUnlinkedEnd(pair.fromRef, pair.from),
                          readUnlinkedEnd(pair.toRef, pair.to),
                        );
                      }}
                    >
                      Unlink
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          {view.isCut && (
            <p className="ib-group-cut">
              This group has more than the pane lists, so the list is cut.
            </p>
          )}
        </section>
      </div>
      <footer className="ib-pane-foot-box">
        <div className="ib-pane-foot">
          <InboxPaneTakeOnButton onTakeOn={onTakeOn} />
          <InboxPaneFootEnd>
            <InboxPaneLinkButton words="Link another thing" onLink={onLink} />
            <InboxPaneDismissButton
              words={`Dismiss all ${String(view.members.length)}`}
              onDismiss={onDismiss}
            />
          </InboxPaneFootEnd>
        </div>
      </footer>
    </>
  );
}
