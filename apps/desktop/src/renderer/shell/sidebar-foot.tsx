import { memo, type JSX } from "react";
import { UserAvatar } from "../faces";
import { SlidersIcon } from "../icons";

/**
 * Renders the sidebar's foot: how many threads are working, waiting on you
 * and idle, then the signed-in user and the Settings button.
 *
 * Each count shows even at 0, so the line keeps its shape. The waiting count
 * is drawn in the attention hue (`you-ink`) only when it is above 0, because
 * that hue means something needs the user. The Settings button is drawn but
 * does nothing yet: there is no settings screen, and `aria-disabled` tells
 * assistive technology so.
 */
export const SidebarFoot = memo(function SidebarFoot({
  working,
  waiting,
  idle,
  username,
}: {
  readonly working: number;
  readonly waiting: number;
  readonly idle: number;
  readonly username: string;
}): JSX.Element {
  return (
    <div className="side-foot">
      <div className="side-sum">
        <b>{working}</b> working · <b className={waiting > 0 ? "you-ink" : undefined}>{waiting}</b>{" "}
        waiting · <b>{idle}</b> idle
      </div>
      <div className="side-me">
        <UserAvatar name={username} size={24} />
        <span className="side-name">{username}</span>
        <button
          type="button"
          className="icon-btn icon-btn--sm"
          title="Settings"
          aria-disabled="true"
        >
          <SlidersIcon size={14} />
        </button>
      </div>
    </div>
  );
});
