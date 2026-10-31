import { Fragment, type JSX, type ReactNode } from "react";
import {
  describeModelRow,
  type ModelMenu,
  type ModelMenuRow,
  type SignInTarget,
  type ThreadChoice,
} from "@hercule/client-core";
import { HarnessLogo } from "@hercule/ui";
import { Lane, MenuFoot, MenuRow, renderMarker } from "./menu";

/** Classes that make the Sign in on a dimmed row look like the row's note, not a button. */
const ROW_SIGN_IN =
  "p-0 text-[11px] leading-normal font-normal text-muted enabled:hover:bg-transparent";

/**
 * The list in the model menu, below the filter. `buildModelMenu` decides what
 * it holds; this component only draws it.
 *
 * A draft shows the profile's Recent entries, then one lane per Provider
 * Account with its entries. A running thread shows one flat list and the line
 * that tells the user other models start a new thread. An entry that cannot
 * run stays in the list, dimmed, with its reason at the right and, when
 * signing in would fix it, a Sign in on the row.
 */
export function ModelList({
  menu,
  renderProviderMark,
  onChoose,
  signInSlot,
}: {
  readonly menu: ModelMenu;
  /** Draws the mark of a Provider, which marks the lanes of its accounts. */
  readonly renderProviderMark: (providerId: string) => ReactNode;
  readonly onChoose: (choice: ThreadChoice) => void;
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

  const { profile } = menu;
  if (profile === null || emptyNote !== null) return <>{emptyNote}</>;
  return (
    <>
      {profile.recent.length === 0 ? null : <Lane label="Recent" />}
      {profile.recent.map((row) =>
        renderRow(row, `recent:${buildRowKey(row)}`, { account: row.account, showCheck: false }),
      )}
      {profile.lanes.map((lane) => (
        <Fragment key={lane.providerAccountId}>
          <Lane label={lane.name} logo={renderProviderMark(lane.providerId)} />
          {lane.note === null ? null : (
            <p className="py-1.5 pr-2 pl-8 text-meta text-faint">{lane.note}</p>
          )}
          {lane.rows.map((row) => renderRow(row, buildRowKey(row), { showCheck: true }))}
        </Fragment>
      ))}
    </>
  );
}
