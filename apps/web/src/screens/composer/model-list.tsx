import { Fragment, type JSX, type ReactNode } from "react";
import {
  describeAccountRow,
  describeModelRow,
  type SignInTarget,
  type ModelMenu,
} from "@hercule/client-core";
import { HarnessLogo } from "@hercule/ui";
import { Lane, renderMarker, MenuRow } from "./menu";

type Row = ModelMenu["current"]["rows"][number];

/** Classes that make the Sign in on an account's row look like the row's note, not a button. */
const ROW_SIGN_IN =
  "p-0 text-[11px] leading-normal font-normal text-muted enabled:hover:bg-transparent";

/**
 * The list in the model menu, below the filter. It shows, in order:
 *
 * - Recent: the models picked most recently;
 * - the account in use, with its older models collapsed;
 * - every other account, as one row that says why it cannot be picked, or as
 *   a lane of its own when the filter matches models in it.
 */
export function ModelList({
  menu,
  older,
  onOlder,
  onPickModel,
  onPickAccount,
  signInSlot,
}: {
  readonly menu: ModelMenu;
  readonly older: boolean;
  readonly onOlder: () => void;
  readonly onPickModel: (providerAccountId: string, model: string) => void;
  readonly onPickAccount: (providerAccountId: string) => void;
  readonly signInSlot: (target: SignInTarget, className: string) => ReactNode;
}): JSX.Element {
  const renderModelRow = (harnessId: string | null, row: Row): JSX.Element => (
    <MenuRow
      key={`${row.providerAccountId}:${row.slug}`}
      marker={renderMarker(harnessId === null ? null : <HarnessLogo harnessId={harnessId} />)}
      name={row.name}
      detail={describeModelRow(row)}
      note={row.current ? "✓" : undefined}
      current={row.current}
      onPick={() => {
        onPickModel(row.providerAccountId, row.slug);
      }}
    />
  );

  return (
    <>
      {menu.recent.length === 0 ? null : <Lane label="Recent" />}
      {menu.recent.map((row) => (
        <MenuRow
          key={`recent:${row.providerAccountId}:${row.model}`}
          marker={renderMarker(<HarnessLogo harnessId={row.harnessId} />)}
          name={row.name}
          detail={row.account}
          dimmed={row.dimmed}
          onPick={() => {
            onPickModel(row.providerAccountId, row.model);
          }}
        />
      ))}
      {menu.current.label === null ? null : <Lane label={menu.current.label} />}
      {menu.current.rows.map((row) => renderModelRow(menu.current.harnessId, row))}
      {menu.current.older.length === 0 ? null : older ? (
        menu.current.older.map((row) => renderModelRow(menu.current.harnessId, row))
      ) : (
        <MenuRow
          marker={renderMarker(null)}
          name={<span className="text-faint">older models ({menu.current.older.length}) ›</span>}
          onPick={onOlder}
        />
      )}
      {menu.others.map((account) =>
        account.dimmed !== null || account.rows.length === 0 ? (
          <MenuRow
            key={account.providerAccountId}
            className="mt-1 rounded-t-none border-t border-line-soft pt-[9px]"
            marker={renderMarker(<HarnessLogo harnessId={account.harnessId} />)}
            name={account.name}
            detail={describeAccountRow(account)}
            note={account.dimmed === null ? `${account.models} ›` : undefined}
            dimmed={account.dimmed}
            trailing={account.signIn === null ? null : signInSlot(account.signIn, ROW_SIGN_IN)}
            onPick={() => {
              onPickAccount(account.providerAccountId);
            }}
          />
        ) : (
          <Fragment key={account.providerAccountId}>
            <Lane label={account.name} />
            {account.rows.map((row) => renderModelRow(account.harnessId, row))}
          </Fragment>
        ),
      )}
    </>
  );
}
