import { Fragment, type JSX } from "react";
import {
  describeModelRow,
  findProviderPluginId,
  type ModelMenu,
  type ModelMenuProfile,
  type ModelMenuRow,
  type PluginIdentity,
  type SignInTarget,
  type ThreadCatalogs,
  type ThreadChoice,
} from "@hercule/client-core";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { ProfileFace } from "../profile-face";
import { ProviderMark } from "../settings/providers/provider-mark";
import { MenuLine } from "./menu-line";
import "./model-menu-list.css";

/** The size of the Provider's mark beside a lane's name and a Recent row. */
const MARK_SIZE = 12;

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
  readonly onEnterLane?: ((providerAccountId: string) => void) | undefined;
  readonly onLeaveLane?: ((providerAccountId: string) => void) | undefined;
  readonly highlightedAccountId?: string | null;
}): JSX.Element {
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
        key={`${row.providerAccountId}:${row.harnessId}:${row.model}`}
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
      {profile.lanes.map((lane) => (
        <div
          key={lane.providerAccountId}
          className={lane.providerAccountId === highlightedAccountId ? "pop-sec is-lit" : "pop-sec"}
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
          {lane.note === null ? lane.rows.map((row) => renderRow(row)) : null}
          {lane.note === null ? null : <p className="menu-note">{lane.note}</p>}
        </div>
      ))}
    </>
  );

  if (menu.kind === "active") {
    return (
      <>
        <div className="model-menu-list">
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
    <div className="model-menu-list">
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
