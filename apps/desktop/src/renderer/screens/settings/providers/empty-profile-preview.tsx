import type { JSX } from "react";
import { ComposeIcon } from "../../../icons/compose";
import { ChevronRightIcon } from "../../../icons/chevron-right";
import { ProfileFace } from "../../profile-face";
import "../../thread/menus.css";
import "../../thread/model-menu-list.css";
import "./profile-preview.css";

/**
 * Renders the faint preview of an empty Model Profile: the composer's model
 * menu with the profile's head unfolded and quiet bars where its accounts and
 * models will appear, and under it "Your models will appear here, under
 * <profile>." It stands where the real preview (`ProfilePreview`) stands once
 * the profile holds a model, and it is hidden from assistive technology
 * because it shows nothing yet.
 */
export function EmptyProfilePreview({
  profileName,
}: {
  readonly profileName: string;
}): JSX.Element {
  return (
    <aside className="pm-ghost" aria-hidden="true">
      <div className="pm-prev-h">
        <ComposeIcon size={13} />
        <b>In the composer</b>
      </div>
      <div className="pop pm-ghost-menu">
        <div className="pop-sec">
          <input
            className="field menu-filter"
            placeholder="Filter models…"
            disabled
            tabIndex={-1}
          />
        </div>
        <div className="ac">
          <div className="ac-head">
            <div className="q-h" aria-expanded="true">
              <ProfileFace name={profileName} size="sm" />
              <span className="ac-name">{profileName}</span>
              <span className="ac-count">0</span>
              <ChevronRightIcon size={12} />
            </div>
          </div>
          <div className="pm-ghost-bars">
            <i className="pm-dash pm-dash--head" />
            <i className="pm-dash" style={{ width: "52%" }} />
            <i className="pm-dash" style={{ width: "64%" }} />
            <i className="pm-dash" style={{ width: "44%" }} />
            <i className="pm-dash pm-dash--head" />
            <i className="pm-dash" style={{ width: "58%" }} />
            <i className="pm-dash" style={{ width: "40%" }} />
          </div>
        </div>
      </div>
      <p className="pm-prev-foot">{`Your models will appear here, under ${profileName}.`}</p>
    </aside>
  );
}
