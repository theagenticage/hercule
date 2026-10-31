import { useState, type JSX } from "react";
import {
  buildModelMenu,
  type PluginIdentity,
  type RecentModel,
  type SignInTarget,
  type ThreadCatalogs,
  type ThreadChoice,
  type ThreadConfig,
  type ThreadKind,
} from "@hercule/client-core";
import { ModelMenuList } from "./model-menu-list";

/**
 * Renders the content of a thread's model menu, as `buildModelMenu` builds
 * it from the user's Model Profiles: a filter when the profiles hold more
 * than eight entries, and under it the list `ModelMenuList` draws.
 *
 * The state of the menu lives here, and it starts afresh each time the menu
 * opens:
 *
 * - the filter's text;
 * - the profile whose head the user clicked, which stays unfolded in place of
 *   the one the menu opened on, and is remembered on this device as the
 *   profile open last. Opening a head never changes the thread's model.
 *
 * `readRecent` returns the Recent list as the app stores it, and
 * `readLastOpenProfileId` the profile open last, or `null`. Both are read
 * once, when the menu opens: they change only when a message is sent or a
 * head is clicked. `rememberOpenProfile` receives the id of each head clicked.
 *
 * `config` is what the thread runs with, picks included, so the check marks
 * the entry the next message will use. `runnerId` is the machine a Draft
 * Thread is bound to, or `null` while any machine will do (see
 * `ModelMenuView`). `plugins` give the Providers their marks. `onChoose`
 * receives the one choice a row makes.
 */
export function ModelMenu({
  catalogs,
  plugins,
  config,
  kind,
  runnerId,
  readRecent,
  readLastOpenProfileId,
  rememberOpenProfile,
  onChoose,
  onSignIn,
}: {
  readonly catalogs: ThreadCatalogs;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly config: ThreadConfig;
  readonly kind: ThreadKind;
  readonly runnerId: string | null;
  readonly readRecent: () => readonly RecentModel[];
  readonly readLastOpenProfileId: () => string | null;
  readonly rememberOpenProfile: (profileId: string) => void;
  readonly onChoose: (choice: ThreadChoice) => void;
  readonly onSignIn?: ((target: SignInTarget) => void) | undefined;
}): JSX.Element {
  const [filter, setFilter] = useState("");
  const [openedProfileId, setOpenedProfileId] = useState<string | null>(null);
  const [recent] = useState(readRecent);
  const [lastOpenProfileId] = useState(readLastOpenProfileId);
  const menu = buildModelMenu(catalogs, config, {
    kind,
    filter,
    recent,
    openedProfileId,
    lastOpenProfileId,
    runnerId,
  });

  return (
    <div className="model-menu">
      {menu.filterable ? (
        <div className="pop-sec">
          <input
            className="field menu-filter"
            aria-label="Filter models"
            placeholder="Filter models…"
            // The filter is what the user came to the menu for when there are
            // this many entries.
            autoFocus
            value={filter}
            onChange={(event) => {
              setFilter(event.target.value);
            }}
          />
        </div>
      ) : null}
      <ModelMenuList
        menu={menu}
        providers={catalogs.providers}
        plugins={plugins}
        onChoose={onChoose}
        onOpenProfile={(profileId) => {
          setOpenedProfileId(profileId);
          rememberOpenProfile(profileId);
        }}
        onSignIn={onSignIn}
      />
    </div>
  );
}
