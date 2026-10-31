import { Fragment, useEffect, useRef, useState, type JSX } from "react";
import {
  describeModelRow,
  findProviderPluginId,
  formatProfileEntryKey,
  type ModelMenu,
  type ModelMenuLane,
  type ModelMenuProfile,
  type ModelMenuRow,
  type NewModelRow,
  type PluginIdentity,
  type SignInTarget,
  type ThreadCatalogs,
  type ThreadChoice,
} from "@hercule/client-core";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { ProfileFace } from "../profile-face";
import { ProviderMark } from "../settings/providers/provider-mark";
import { MenuLine } from "./menu-line";
import { NewModelLine } from "./new-model-line";
import "./model-menu-list.css";

/** The size of the Provider's mark beside a lane's name and a Recent row. */
const MARK_SIZE = 12;

/**
 * What the list does with the "New" rows of its lanes. A list given none draws
 * the rows without buttons, as a preview does.
 *
 * - `add` and `dismiss` save what the user did to a row, for the profile that
 *   holds the lane. Each resolves with `true` when the save worked and `false`
 *   when it was refused, and never rejects.
 * - `isSaving` tells whether a save of the row runs.
 * - `findRefusal` returns why the last save in the lane was refused, or `null`.
 */
export interface NewModelActions {
  readonly add: (profileId: string, row: NewModelRow) => Promise<boolean>;
  readonly dismiss: (profileId: string, row: NewModelRow) => Promise<boolean>;
  readonly isSaving: (profileId: string, row: NewModelRow) => boolean;
  readonly findRefusal: (profileId: string, lane: ModelMenuLane) => string | null;
}

/**
 * A request to move the keyboard focus once a saved "New" row has left the
 * list.
 *
 * - `sourceElement` is the button that was pressed. It is in the row that
 *   leaves the list when the save works.
 * - `findTarget` returns the element to focus, as the list is when the row
 *   has left, or `null` when there is none.
 */
interface FocusRequest {
  readonly sourceElement: HTMLElement;
  readonly findTarget: () => HTMLElement | null;
}

/** Returns the first element of `container` that matches `selector`, or `null` when `container` is `null` or no longer in the page. */
const findInside = (container: Element | null, selector: string): HTMLElement | null =>
  container?.isConnected === true ? container.querySelector<HTMLElement>(selector) : null;

/**
 * Renders the list of a model menu below its filter, as `buildModelMenu`
 * built it. It reads nothing and holds no state, so the composer's menu and
 * any other screen that shows a built menu draw it the same way.
 *
 * - A menu of a Draft Thread shows its Model Profiles as an accordion: a head
 *   per profile (its face, name, entry count and a chevron) when
 *   `menu.hasHeads`, with the unfolded profile's Recent entries, one lane per
 *   Provider Account and its entries under it, indented below the head.
 * - A menu of a thread that has started shows one flat list and the note that
 *   other models start a new thread.
 *
 * An entry that cannot run is dimmed with its reason at the right, never
 * hidden. When signing in would fix it and `onSignIn` is given, the row also
 * has a Sign in link.
 *
 * A lane starts with a row for each model the controller announced as new
 * (see `NewModelLine`). The row is not a choice. With `newModelActions` it
 * has an Add and a "Not now" button, and the lane shows under its rows why a
 * save was refused; without them it is drawn without buttons. When a save
 * works, the row leaves the list, and with it the keyboard focus the pressed
 * button had. The list then moves the focus on, once, to where the action
 * that saved the row says it should go (see `FocusRequest`).
 *
 * - `providers` and `plugins` give a lane its Provider's mark.
 * - `onChoose` receives the one choice a row makes.
 * - `onOpenProfile` receives the id of the profile whose head is clicked.
 * - `onEnterLane` and `onLeaveLane` receive the id of the Provider Account
 *   whose lane the pointer enters or leaves.
 * - `highlightedAccountId` draws the lane of that Provider Account lit.
 */
export function ModelMenuList({
  menu,
  providers,
  plugins,
  onChoose,
  onOpenProfile,
  onSignIn,
  newModelActions,
  onEnterLane,
  onLeaveLane,
  highlightedAccountId = null,
}: {
  readonly menu: ModelMenu;
  readonly providers: ThreadCatalogs["providers"];
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly onChoose: (choice: ThreadChoice) => void;
  readonly onOpenProfile: (profileId: string) => void;
  readonly onSignIn?: ((target: SignInTarget) => void) | undefined;
  readonly newModelActions?: NewModelActions | undefined;
  readonly onEnterLane?: ((providerAccountId: string) => void) | undefined;
  readonly onLeaveLane?: ((providerAccountId: string) => void) | undefined;
  readonly highlightedAccountId?: string | null;
}): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const focusRequest = useRef<FocusRequest | null>(null);
  const [, redraw] = useState(0);
  // Runs after every draw while a request is waiting, because the row leaves
  // the list in a draw of its own, which can come before or after the save's
  // answer. The request ends at the first draw that settles it:
  // - while the focus is still on the pressed button, the row has not left yet,
  //   and the request waits;
  // - when the focus is elsewhere and the row is still there, the user moved
  //   on, and the request ends without moving the focus;
  // - when the row has left, the request ends, and the focus moves only if the
  //   browser dropped it to the page.
  useEffect(() => {
    const request = focusRequest.current;
    if (request === null) return;
    const { sourceElement, findTarget } = request;
    if (sourceElement.isConnected && document.activeElement === sourceElement) return;
    focusRequest.current = null;
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (!sourceElement.isConnected && lost) findTarget()?.focus();
  });

  const renderMark = (providerId: string): JSX.Element => (
    <ProviderMark
      pluginId={findProviderPluginId(providers, { providerId })}
      plugins={plugins}
      size={MARK_SIZE}
    />
  );

  const renderRow = (
    row: ModelMenuRow,
    options: { readonly account?: string | null; readonly mark?: boolean } = {},
  ): JSX.Element => {
    const detail = [options.account ?? null, describeModelRow(row)]
      .filter((part) => part !== null)
      .join(" · ");
    const { problem } = row;
    const signIn = problem?.signIn ?? null;
    return (
      <MenuLine
        key={formatProfileEntryKey(row)}
        entry={row}
        glyph={options.mark === true ? renderMark(row.providerId) : null}
        name={row.name}
        detail={detail === "" ? null : detail}
        note={problem?.message}
        current={row.isCurrent}
        inert={problem !== null}
        action={
          signIn === null || onSignIn === undefined
            ? null
            : {
                label: "Sign in",
                onAct: () => {
                  onSignIn(signIn);
                },
              }
        }
        onPick={() => {
          onChoose({
            kind: "model",
            providerAccountId: row.providerAccountId,
            harnessId: row.harnessId,
            model: row.model,
          });
        }}
      />
    );
  };

  /** Draws the row of a model announced as new in a lane of the profile `profileId`. */
  const renderNewModel = (profileId: string, row: NewModelRow): JSX.Element => {
    /**
     * Runs `run` for the row the button `source` is in. When it works, asks for
     * the focus to go to what `findDestination` returns once the row has left,
     * else to the first entry of its lane, else to the first control of the
     * list. `findDestination` receives the lane's element.
     */
    const startSave = (
      run: (profileId: string, row: NewModelRow) => Promise<boolean>,
      source: HTMLElement,
      findDestination: (laneElement: Element | null) => HTMLElement | null,
    ): void => {
      const laneElement = source.closest(".pop-sec");
      void run(profileId, row).then((worked) => {
        if (!worked) return;
        focusRequest.current = {
          sourceElement: source,
          findTarget: () =>
            findDestination(laneElement) ??
            findInside(laneElement, "button[data-model]") ??
            findInside(listRef.current, "input, button:not([data-unready])"),
        };
        redraw((count) => count + 1);
      });
    };
    return (
      <NewModelLine
        key={`${row.providerAccountId}:${row.model}`}
        row={row}
        actions={
          newModelActions === undefined
            ? null
            : {
                onAdd: (source) => {
                  startSave(
                    newModelActions.add,
                    source,
                    (laneElement) =>
                      // The entry may be in another harness than the row's section.
                      [
                        ...(laneElement?.querySelectorAll<HTMLElement>("button[data-model]") ?? []),
                      ].find(
                        (entry) =>
                          entry.dataset["accountId"] === row.providerAccountId &&
                          entry.dataset["model"] === row.model,
                      ) ?? null,
                  );
                },
                onDismiss: (source) => {
                  const nextRow = source.closest(".line--new")?.nextElementSibling;
                  startSave(newModelActions.dismiss, source, () =>
                    nextRow?.classList.contains("line--new") === true
                      ? findInside(nextRow, ".line-action")
                      : null,
                  );
                },
                busy: newModelActions.isSaving(profileId, row),
              }
        }
      />
    );
  };

  /** Draws what an unfolded profile holds: its note, Recent, and its lanes. */
  const renderProfileBody = (profile: ModelMenuProfile): JSX.Element => (
    <>
      {profile.empty === null ? null : <p className="menu-note">{profile.empty}</p>}
      {profile.recent.length === 0 ? null : (
        <div className="pop-sec">
          <div className="q-h">Recent</div>
          {profile.recent.map((row) => renderRow(row, { account: row.account, mark: true }))}
        </div>
      )}
      {profile.lanes.map((lane) => {
        const problem = newModelActions?.findRefusal(profile.profileId, lane) ?? null;
        return (
          <div
            key={lane.providerAccountId}
            className={
              lane.providerAccountId === highlightedAccountId ? "pop-sec is-lit" : "pop-sec"
            }
            onPointerEnter={
              onEnterLane === undefined
                ? undefined
                : () => {
                    onEnterLane(lane.providerAccountId);
                  }
            }
            onPointerLeave={
              onLeaveLane === undefined
                ? undefined
                : () => {
                    onLeaveLane(lane.providerAccountId);
                  }
            }
          >
            <div className="q-h">
              {renderMark(lane.providerId)}
              {lane.name}
            </div>
            {lane.newModels.map((row) => renderNewModel(profile.profileId, row))}
            {lane.note === null ? lane.rows.map((row) => renderRow(row)) : null}
            {lane.note === null ? null : <p className="menu-note">{lane.note}</p>}
            {problem === null ? null : (
              <p className="menu-note menu-note--fail" role="alert">
                {problem}
              </p>
            )}
          </div>
        );
      })}
    </>
  );

  if (menu.kind === "active") {
    return (
      <>
        <div className="model-menu-list" ref={listRef}>
          {menu.empty === null ? (
            <div className="pop-sec">{menu.rows.map((row) => renderRow(row))}</div>
          ) : (
            <p className="menu-note">{menu.empty}</p>
          )}
        </div>
        <p className="pop-foot">{menu.note}</p>
      </>
    );
  }

  return (
    <div className="model-menu-list" ref={listRef}>
      {menu.empty !== null ? <p className="menu-note">{menu.empty}</p> : null}
      {menu.profiles.map((profile) =>
        menu.hasHeads ? (
          <div key={profile.profileId} className="ac">
            <div className="ac-head">
              <button
                type="button"
                className="q-h"
                aria-expanded={profile.unfolded}
                onClick={() => {
                  onOpenProfile(profile.profileId);
                }}
              >
                <ProfileFace name={profile.name} size="sm" />
                <span className="ac-name">{profile.name}</span>
                <span className="ac-count">{profile.entryCount}</span>
                <ChevronRightIcon size={12} />
              </button>
            </div>
            {profile.unfolded ? renderProfileBody(profile) : null}
          </div>
        ) : (
          <Fragment key={profile.profileId}>{renderProfileBody(profile)}</Fragment>
        ),
      )}
    </div>
  );
}
