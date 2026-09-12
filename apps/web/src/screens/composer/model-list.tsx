import { Fragment, type JSX, type ReactNode } from "react";
import type { LoginTarget, ModelMenu } from "@hydra/client-core";
import { ProviderLogo } from "@hydra/ui";
import { Lane, markerOf, MenuRow } from "./menu";

type Row = ModelMenu["current"]["rows"][number];
type Instance = ModelMenu["others"][number];

/** An account's row names who is logged in and on what plan, beside the account. */
const whoOf = (instance: Instance): string =>
  [instance.identity, instance.planLabel].filter((each) => each !== null).join(" · ");

/** The Log in on an account's row reads as the row's own note, not as a button. */
const ROW_LOGIN =
  "p-0 text-[11px] leading-normal font-normal text-muted enabled:hover:bg-transparent";

/**
 * What the model menu lists under its filter: what was reached for last, the
 * account in use with its older models folded away, and every other account as
 * one row saying why it cannot be picked - or as a lane of its own, where the
 * filter reached into it.
 */
export function ModelList({
  menu,
  older,
  onOlder,
  onPickModel,
  onPickInstance,
  loginSlot,
}: {
  readonly menu: ModelMenu;
  readonly older: boolean;
  readonly onOlder: () => void;
  readonly onPickModel: (instanceId: string, model: string) => void;
  readonly onPickInstance: (instanceId: string) => void;
  readonly loginSlot: (login: LoginTarget, className: string) => ReactNode;
}): JSX.Element {
  const modelRow = (providerId: string | null, row: Row): JSX.Element => (
    <MenuRow
      key={`${row.instanceId}:${row.slug}`}
      marker={markerOf(providerId === null ? null : <ProviderLogo providerId={providerId} />)}
      name={row.name}
      detail={row.isDefault && !row.current ? "default" : null}
      note={row.current ? "✓" : undefined}
      current={row.current}
      onPick={() => {
        onPickModel(row.instanceId, row.slug);
      }}
    />
  );

  return (
    <>
      {menu.recent.length === 0 ? null : <Lane label="Recent" />}
      {menu.recent.map((row) => (
        <MenuRow
          key={`recent:${row.instanceId}:${row.model}`}
          marker={markerOf(<ProviderLogo providerId={row.providerId} />)}
          name={row.name}
          detail={row.account}
          dimmed={row.dimmed}
          onPick={() => {
            onPickModel(row.instanceId, row.model);
          }}
        />
      ))}
      {menu.current.label === null ? null : <Lane label={menu.current.label} />}
      {menu.current.rows.map((row) => modelRow(menu.current.providerId, row))}
      {menu.current.older.length === 0 ? null : older ? (
        menu.current.older.map((row) => modelRow(menu.current.providerId, row))
      ) : (
        <MenuRow
          marker={markerOf(null)}
          name={<span className="text-faint">older models ({menu.current.older.length}) ›</span>}
          onPick={onOlder}
        />
      )}
      {menu.others.map((instance) =>
        instance.dimmed !== null || instance.rows.length === 0 ? (
          <MenuRow
            key={instance.instanceId}
            className="mt-1 rounded-t-none border-t border-line-soft pt-[9px]"
            marker={markerOf(<ProviderLogo providerId={instance.providerId} />)}
            name={instance.name}
            detail={whoOf(instance)}
            note={instance.dimmed === null ? `${String(instance.modelCount)} models ›` : undefined}
            dimmed={instance.dimmed}
            trailing={instance.login === null ? null : loginSlot(instance.login, ROW_LOGIN)}
            onPick={() => {
              onPickInstance(instance.instanceId);
            }}
          />
        ) : (
          <Fragment key={instance.instanceId}>
            <Lane label={instance.name} />
            {instance.rows.map((row) => modelRow(instance.providerId, row))}
          </Fragment>
        ),
      )}
    </>
  );
}
