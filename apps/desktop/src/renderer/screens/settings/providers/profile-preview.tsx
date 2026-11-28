import type { JSX } from "react";
import type { ModelMenu, PluginIdentity, ThreadCatalogs } from "@hercule/client-core";
import { ComposeIcon } from "../../../icons/compose";
import { ModelMenuList } from "../../thread/model-menu-list";
import "../../thread/menus.css";
import "./profile-preview.css";

/**
 * Renders the composer's model menu as a preview on Settings > Providers >
 * Models: `menu`, the menu `buildModelMenu` built for a new thread with the
 * open Model Profile unfolded, drawn by the composer's own list
 * (`ModelMenuList`). Picking a row does nothing, because this is only a
 * preview.
 *
 * A lane the pointer enters or leaves is reported through `onEnterLane` and
 * `onLeaveLane`, and the lane of `highlightedAccountId` is drawn lit, so the
 * page can link the preview to its sections.
 *
 * `profileName` names the open profile in the heading's note, which is "every
 * thread" when the menu has no profile heads (there is only one profile).
 */
export function ProfilePreview({
  menu,
  profileName,
  providers,
  plugins,
  highlightedAccountId,
  onEnterLane,
  onLeaveLane,
}: {
  readonly menu: ModelMenu;
  readonly profileName: string;
  readonly providers: ThreadCatalogs["providers"];
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly highlightedAccountId: string | null;
  readonly onEnterLane: (providerAccountId: string) => void;
  readonly onLeaveLane: (providerAccountId: string) => void;
}): JSX.Element {
  const hasHeads = menu.kind === "draft" && menu.hasHeads;
  return (
    <aside className="pm-preview">
      <div className="pm-prev-h">
        <ComposeIcon size={13} />
        <b>In the composer</b>
        <small>{hasHeads ? `a thread using ${profileName}` : "every thread"}</small>
      </div>
      <div className="pop pm-preview-menu">
        <div className="model-menu">
          {/* Only a picture of the composer's filter, so assistive technology skips it. */}
          <div className="pop-sec" aria-hidden="true">
            <input className="field menu-filter" placeholder="Filter models…" disabled />
          </div>
          <ModelMenuList
            menu={menu}
            providers={providers}
            plugins={plugins}
            highlightedAccountId={highlightedAccountId}
            onChoose={ignorePick}
            onOpenProfile={ignorePick}
            onEnterLane={onEnterLane}
            onLeaveLane={onLeaveLane}
          />
        </div>
      </div>
      {hasHeads ? <p className="pm-prev-foot">One profile open at a time.</p> : null}
    </aside>
  );
}

/** Does nothing: a click on the preview changes nothing. */
function ignorePick(): void {}
