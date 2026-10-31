import { Fragment, type JSX, type ReactNode } from "react";
import {
  describeModelRow,
  type ModelMenu,
  type ModelMenuRow,
  type NewModelRow,
  type SignInTarget,
  type ThreadChoice,
} from "@hercule/client-core";
import { Button, HarnessLogo } from "@hercule/ui";
import { Lane, MenuFoot, MenuRow, ProfileHead, renderMarker } from "./menu";

/** Classes that make the Sign in on a dimmed row look like the row's note, not a button. */
const ROW_SIGN_IN =
  "p-0 text-[11px] leading-normal font-normal text-muted enabled:hover:bg-transparent";

/** Why a save of a New row failed, and the lane it is shown under. */
export interface NewModelRefusal {
  readonly profileId: string;
  readonly providerAccountId: string;
  readonly message: string;
}

/**
 * The list in the model menu, below the filter. `buildModelMenu` decides what
 * it holds; this component only draws it.
 *
 * A draft shows its profiles as an accordion: a head per profile (none when
 * the user has one profile), and under the unfolded head the profile's Recent
 * entries, then one lane per Provider Account with its entries. A running thread shows one flat list and the line
 * that tells the user other models start a new thread. An entry that cannot
 * run stays in the list, dimmed, with its reason at the right and, when
 * signing in would fix it, a Sign in on the row.
 *
 * A lane begins with a row for each model announced as new, with Add and Not
 * now. Neither picks the model or closes the menu. While `savingNewModel`
 * holds, every such button is disabled, because saves run one after another.
 * `newModelRefusal` shows under the lane of the row whose save was refused.
 */
export function ModelList({
  menu,
  renderProviderMark,
  onChoose,
  onOpenProfile,
  onAddNewModel,
  onDismissNewModel,
  savingNewModel,
  newModelRefusal,
  signInSlot,
}: {
  readonly menu: ModelMenu;
  /** Draws the mark of a Provider, which marks the lanes of its accounts. */
  readonly renderProviderMark: (providerId: string) => ReactNode;
  readonly onChoose: (choice: ThreadChoice) => void;
  readonly onOpenProfile: (profileId: string) => void;
  /** Adds the model of a New row to the profile whose lane holds the row. */
  readonly onAddNewModel: (profileId: string, row: NewModelRow) => void;
  /** Hides the model of a New row for good in the profile whose lane holds the row. */
  readonly onDismissNewModel: (profileId: string, row: NewModelRow) => void;
  /** Whether a save of a New row is running. */
  readonly savingNewModel: boolean;
  /** The refusal of the last save of a New row, or `null`. */
  readonly newModelRefusal: NewModelRefusal | null;
  readonly signInSlot: (target: SignInTarget, className: string) => ReactNode;
}): JSX.Element {
  const renderRow = (
    row: ModelMenuRow,
    key: string,
    options: { readonly account?: string | null; readonly showCheck: boolean },
  ): JSX.Element => {
    const detail = [options.account ?? null, describeModelRow(row)]
      .filter((part) => part !== null)
      .join(" · ");
    return (
      <MenuRow
        key={key}
        marker={renderMarker(<HarnessLogo harnessId={row.harnessId} />)}
        name={row.name}
        detail={detail}
        note={options.showCheck && row.isCurrent ? "✓" : undefined}
        current={options.showCheck && row.isCurrent}
        dimmed={row.problem?.message ?? null}
        trailing={row.problem?.signIn == null ? null : signInSlot(row.problem.signIn, ROW_SIGN_IN)}
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
  const renderNewModelRow = (profileId: string, row: NewModelRow): JSX.Element => (
    <MenuRow
      key={`new:${row.providerAccountId}:${row.model}`}
      marker={renderMarker(null)}
      name={
        <>
          <span className="mr-1.5 text-label font-emph tracking-[0.1em] text-faint uppercase">
            New
          </span>
          {row.name}
        </>
      }
      detail={row.arrivalText}
      inert
      note={
        <>
          <Button
            disabled={savingNewModel}
            aria-label={`Add ${row.name}`}
            className="px-1.5 py-0.5 text-[11px] font-normal"
            onClick={() => {
              onAddNewModel(profileId, row);
            }}
          >
            Add
          </Button>
          <Button
            disabled={savingNewModel}
            title="Not now"
            aria-label={`Not now for ${row.name}`}
            className="px-1.5 py-0.5 text-[13px] font-normal"
            onClick={() => {
              onDismissNewModel(profileId, row);
            }}
          >
            ×
          </Button>
        </>
      }
    />
  );
  const buildRowKey = (row: ModelMenuRow): string =>
    `${row.providerAccountId}:${row.harnessId}:${row.model}`;

  const emptyNote =
    menu.empty === null ? null : <p className="px-2 py-1.5 text-meta text-faint">{menu.empty}</p>;
  if (menu.kind === "active") {
    return (
      <>
        {emptyNote}
        {menu.rows.map((row) => renderRow(row, buildRowKey(row), { showCheck: true }))}
        <MenuFoot>{menu.note}</MenuFoot>
      </>
    );
  }

  if (emptyNote !== null) return <>{emptyNote}</>;
  return (
    <>
      {menu.profiles.map((profile) => (
        <Fragment key={profile.profileId}>
          {menu.hasHeads ? (
            <ProfileHead
              label={profile.name}
              unfolded={profile.unfolded}
              onOpen={() => {
                onOpenProfile(profile.profileId);
              }}
            />
          ) : null}
          {profile.empty === null ? null : (
            <p className="px-2 py-1.5 text-meta text-faint">{profile.empty}</p>
          )}
          {profile.recent.length === 0 ? null : <Lane label="Recent" />}
          {profile.recent.map((row) =>
            renderRow(row, `recent:${buildRowKey(row)}`, {
              account: row.account,
              showCheck: false,
            }),
          )}
          {profile.lanes.map((lane) => (
            <Fragment key={lane.providerAccountId}>
              <Lane label={lane.name} logo={renderProviderMark(lane.providerId)} />
              {lane.note === null ? null : (
                <p className="py-1.5 pr-2 pl-8 text-meta text-faint">{lane.note}</p>
              )}
              {lane.newModels.map((row) => renderNewModelRow(profile.profileId, row))}
              {lane.rows.map((row) => renderRow(row, buildRowKey(row), { showCheck: true }))}
              {newModelRefusal?.profileId === profile.profileId &&
              newModelRefusal.providerAccountId === lane.providerAccountId ? (
                <p className="py-1.5 pr-2 pl-8 text-fine text-fail" role="alert">
                  {newModelRefusal.message}
                </p>
              ) : null}
            </Fragment>
          ))}
        </Fragment>
      ))}
    </>
  );
}
