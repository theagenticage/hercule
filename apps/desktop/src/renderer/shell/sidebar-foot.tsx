import { memo, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import { UserAvatar } from "../faces";
import { SlidersIcon } from "../icons/sliders";
import { SELECTED_LINK_PROPS } from "../screens/selected-link-props";

/**
 * Renders the sidebar's foot: how many threads are working, waiting on you
 * and idle, then the signed-in user and the Settings button.
 *
 * Each count shows even at 0, so the line keeps its shape. The waiting count
 * is drawn in the attention hue (`you-ink`) only when it is above 0, because
 * that hue means something needs the user. The Settings button opens
 * Settings, and shows as pressed while Settings is open, as the Office button
 * does for the Office.
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
        <Link
          to="/settings"
          className="icon-btn icon-btn--sm"
          title="Settings"
          activeProps={SELECTED_LINK_PROPS}
        >
          <SlidersIcon size={14} />
        </Link>
      </div>
    </div>
  );
});
