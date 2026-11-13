import type { JSX } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import { describeSelectedThings, type InboxRowView } from "@hercule/client-core/inbox";
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";
import { CheckIcon } from "../../icons/check";
import { PluginMark } from "../../marks";
import { EntityStatusIcon } from "../desk/status-shape";
import { InboxPaneDismiss } from "./inbox-pane-footer";
import "./inbox-pane-head.css";
import "./inbox-pane-thing.css";
import "./inbox-selection-pane.css";

/** Returns the hint line under the selection's title, naming the click that adds a row on `platform`. */
const describeSelectionHint = (platform: DesktopPlatform): string =>
  `X or ${platform === "mac" ? "⌘" : "Ctrl"}-click adds and removes; ⇧ selects a range; Esc clears`;

/**
 * Renders the pane's head line while a selection shows: the check icon and
 * "Selected · GitHub, Linear", `sourceNames` being the sources the selected
 * things come from, each once.
 */
export function InboxSelectionHead({
  sourceNames,
}: {
  readonly sourceNames: ReadonlyArray<string>;
}): JSX.Element {
  return (
    <p className="ib-pane-source">
      <span className="ib-pane-source-mark">
        <CheckIcon size={14} />
      </span>
      <span className="ib-pane-source-words">{`Selected · ${sourceNames.join(", ")}`}</span>
    </p>
  );
}

/**
 * Renders the pane of a selection of things: "3 things selected", the hint
 * for the selection keys, one row for each `member` and a footer that holds
 * Dismiss only, named "Dismiss all 3".
 *
 * A member row is a button that calls `onWalk` with the member's reference,
 * so the pane walks to that thing. Taking on and handing off a selection are
 * not offered here: their keys say why in the undo line.
 */
export function InboxSelectionPane({
  members,
  plugins,
  platform,
  onWalk,
  onDismiss,
}: {
  readonly members: ReadonlyArray<InboxRowView>;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly platform: DesktopPlatform;
  readonly onWalk: (ref: string) => void;
  readonly onDismiss: () => void;
}): JSX.Element {
  const count = members.length;
  return (
    <>
      <div className="ib-pane-scroll">
        <h2 className="ib-pane-title">{describeSelectedThings(count)}</h2>
        <p className="ib-pane-meta">
          <span>{describeSelectionHint(platform)}</span>
        </p>
        <section className="ib-pane-sec ib-pane-sec--first">
          <ul className="ib-pane-members">
            {members.map((member) => (
              <li key={member.ref}>
                <button
                  type="button"
                  className="ib-pane-member"
                  aria-label={member.label}
                  onClick={() => {
                    onWalk(member.ref);
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
                    {member.reason.who === undefined ? null : <b>{member.reason.who} </b>}
                    {member.reason.rest}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
      <footer className="ib-pane-foot-box">
        <div className="ib-pane-foot">
          <InboxPaneDismiss words={`Dismiss all ${String(count)}`} onDismiss={onDismiss} />
        </div>
      </footer>
    </>
  );
}
