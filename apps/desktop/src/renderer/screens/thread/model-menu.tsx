import { useState, type JSX } from "react";
import {
  buildModelMenu,
  readErrorMessage,
  type ModelProfileSave,
  type NewModelRow,
  type PluginIdentity,
  type RecentModel,
  type SignInTarget,
  type ThreadCatalogs,
  type ThreadChoice,
  type ThreadConfig,
  type ThreadKind,
} from "@hercule/client-core";
import { ModelMenuList, type NewModelActions } from "./model-menu-list";

/** Returns the key under which the menu tracks the refusal shown in the lane of an account in a profile. */
const formatLaneKey = (profileId: string, providerAccountId: string): string =>
  `${profileId}:${providerAccountId}`;

/** Returns the key under which the menu tracks the save of one "New" row. */
const formatNewModelKey = (profileId: string, row: NewModelRow): string =>
  `${profileId}:${row.providerAccountId}:${row.model}`;

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
 * `saveProfile` saves a change to a Model Profile: it receives what to save
 * (`ModelProfileSave`) and returns a promise that is rejected when the save is
 * refused. The menu uses it for what the user does to a "New" row (`NewModelLine`): Add takes the
 * model into the profile and "Not now" hides it for good. Neither picks the
 * model or closes the menu. The menu keeps the buttons of a row busy while its
 * save runs, and shows a refusal under the row's lane. Without `saveProfile`
 * the rows have no buttons. `timezone` is the zone the dates of the rows are
 * read in.
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
  timezone,
  readRecent,
  readLastOpenProfileId,
  rememberOpenProfile,
  onChoose,
  onSignIn,
  saveProfile,
}: {
  readonly catalogs: ThreadCatalogs;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly config: ThreadConfig;
  readonly kind: ThreadKind;
  readonly runnerId: string | null;
  readonly timezone: string;
  readonly readRecent: () => readonly RecentModel[];
  readonly readLastOpenProfileId: () => string | null;
  readonly rememberOpenProfile: (profileId: string) => void;
  readonly onChoose: (choice: ThreadChoice) => void;
  readonly onSignIn?: ((target: SignInTarget) => void) | undefined;
  readonly saveProfile?: ((change: ModelProfileSave) => Promise<unknown>) | undefined;
}): JSX.Element {
  const [filter, setFilter] = useState("");
  const [openedProfileId, setOpenedProfileId] = useState<string | null>(null);
  const [recent] = useState(readRecent);
  const [lastOpenProfileId] = useState(readLastOpenProfileId);
  // The date the "New" rows are counted from is the one the menu opened on.
  const [now] = useState(() => new Date());
  const [savingKeys, setSavingKeys] = useState<ReadonlySet<string>>(new Set());
  const [refusals, setRefusals] = useState<ReadonlyMap<string, string>>(new Map());

  /**
   * Saves what `edit` does to the profile `profileId` for a "New" row, with
   * the row's buttons busy until it is over. Resolves with `true` when the
   * save worked. A refusal is shown in the row's lane and resolves with
   * `false`.
   */
  const saveNewModel = (
    save: NonNullable<typeof saveProfile>,
    profileId: string,
    row: NewModelRow,
    action: "add" | "dismiss",
  ): Promise<boolean> => {
    const rowKey = formatNewModelKey(profileId, row);
    const laneKey = formatLaneKey(profileId, row.providerAccountId);
    setSavingKeys((keys) => new Set(keys).add(rowKey));
    setRefusals((current) => {
      const rest = new Map(current);
      rest.delete(laneKey);
      return rest;
    });
    return save({
      profileId,
      newModelEdit: { action, providerAccountId: row.providerAccountId, model: row.model },
    })
      .then(
        () => true,
        (error: unknown) => {
          setRefusals((current) =>
            new Map(current).set(laneKey, `The change was not saved. ${readErrorMessage(error)}`),
          );
          return false;
        },
      )
      .finally(() => {
        setSavingKeys((keys) => {
          const rest = new Set(keys);
          rest.delete(rowKey);
          return rest;
        });
      });
  };

  const newModelActions: NewModelActions | undefined =
    saveProfile === undefined
      ? undefined
      : {
          add: (profileId, row) => saveNewModel(saveProfile, profileId, row, "add"),
          dismiss: (profileId, row) => saveNewModel(saveProfile, profileId, row, "dismiss"),
          isSaving: (profileId, row) => savingKeys.has(formatNewModelKey(profileId, row)),
          findRefusal: (profileId, lane) =>
            refusals.get(formatLaneKey(profileId, lane.providerAccountId)) ?? null,
        };

  const menu = buildModelMenu(catalogs, config, {
    kind,
    filter,
    recent,
    openedProfileId,
    lastOpenProfileId,
    runnerId,
    now,
    timezone,
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
        newModelActions={newModelActions}
      />
    </div>
  );
}
