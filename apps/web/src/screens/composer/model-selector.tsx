import { Fragment, useState, type JSX, type ReactNode } from "react";
import type { ComposerPick, LoginTarget, ModelMenu, ModelPill } from "@hydra/client-core";
import { ProviderLogo } from "@hydra/ui";
import { aside, Lane, markerOf, MenuRow } from "./menu-row";
import { SelectorShell } from "./selector-shell";

type Row = ModelMenu["current"]["rows"][number];

/** With no filter to type in, focus stays on the trigger the menu opened from. */
const holdFocus = (event: Event): void => event.preventDefault();

/** The pill's face: the mark, the account where a provider has two, the model. */
const pillLabel = (pill: ModelPill): ReactNode => (
  <>
    {pill.providerId === null ? null : <ProviderLogo providerId={pill.providerId} />}
    {pill.account === null ? null : <span className="text-faint">{pill.account}</span>}{" "}
    <span>{pill.name ?? "No model"}</span>
  </>
);

/**
 * The model selector: the pill, and the catalog behind it - what was reached
 * for last, the account in use with its older models folded away, every other
 * account as one row saying why it cannot be picked, and a filter once there
 * is enough to filter.
 */
export function ModelSelector({
  menuOf,
  pill,
  disabled,
  open,
  onOpenChange,
  onPick,
  loginSlot,
}: {
  readonly menuOf: (filter: string) => ModelMenu;
  readonly pill: ModelPill;
  readonly disabled: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (...steps: readonly ComposerPick[]) => void;
  readonly loginSlot: (login: LoginTarget) => ReactNode;
}): JSX.Element {
  const [filter, setFilter] = useState("");
  const [older, setOlder] = useState(false);
  const menu = menuOf(filter);
  const pick = (...steps: readonly ComposerPick[]): void => {
    onPick(...steps);
    onOpenChange(false);
  };
  // A row carries its account: one reached through the filter or Recent
  // switches account and model together.
  const modelRow = (providerId: string | null, row: Row): JSX.Element => (
    <MenuRow
      key={`${row.instanceId}:${row.slug}`}
      marker={markerOf(providerId === null ? null : <ProviderLogo providerId={providerId} />)}
      name={[row.name, aside(row.isDefault && !row.current ? "default" : null)]}
      note={row.current ? "✓" : undefined}
      current={row.current}
      onPick={() => {
        pick({ kind: "instanceId", value: row.instanceId }, { kind: "model", value: row.slug });
      }}
    />
  );

  const currentRow = (row: Row): JSX.Element => modelRow(menu.current.providerId, row);
  return (
    <SelectorShell
      label={pillLabel(pill)}
      className="rounded-full border border-line bg-surface py-1 pr-[11px] pl-[9px] text-ink hover:bg-surface aria-expanded:border-faint [&>svg]:opacity-80"
      locked={null}
      disabled={disabled}
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setFilter("");
          setOlder(false);
        }
        onOpenChange(next);
      }}
      align="end"
      contentClassName="w-[360px]"
      onOpenAutoFocus={menu.filterable ? undefined : holdFocus}
    >
      {menu.filterable ? (
        <input
          autoFocus
          value={filter}
          placeholder="Filter models…"
          onChange={(event) => {
            setFilter(event.target.value);
          }}
          className="mx-0.5 mt-0.5 mb-1 rounded-[6px] border border-line bg-surface px-2.5 py-[5px] text-meta text-ink outline-none placeholder:text-faint focus:border-live"
        />
      ) : null}
      {menu.recent.length === 0 ? null : <Lane label="Recent" />}
      {menu.recent.map((row) => (
        <MenuRow
          key={`recent:${row.instanceId}:${row.model}`}
          marker={markerOf(<ProviderLogo providerId={row.providerId} />)}
          name={[row.name, aside(row.account)]}
          dimmed={row.dimmed}
          onPick={() => {
            pick(
              { kind: "instanceId", value: row.instanceId },
              { kind: "model", value: row.model },
            );
          }}
        />
      ))}
      {menu.current.label === null ? null : <Lane label={menu.current.label} />}
      {menu.current.rows.map(currentRow)}
      {menu.current.older.length === 0 ? null : older ? (
        menu.current.older.map(currentRow)
      ) : (
        <MenuRow
          marker={markerOf(null)}
          name={aside(`older models (${String(menu.current.older.length)}) ›`)}
          onPick={() => {
            setOlder(true);
          }}
        />
      )}
      {menu.others.map((instance) =>
        instance.dimmed !== null || instance.rows.length === 0 ? (
          <MenuRow
            key={instance.instanceId}
            marker={markerOf(<ProviderLogo providerId={instance.providerId} />)}
            name={instance.name}
            sub={[instance.identity, instance.planLabel]
              .filter((each) => each !== null)
              .join(" · ")}
            note={instance.dimmed === null ? `${String(instance.modelCount)} models ›` : undefined}
            dimmed={instance.dimmed}
            trailing={instance.login === null ? null : loginSlot(instance.login)}
            onPick={() => {
              pick({ kind: "instanceId", value: instance.instanceId });
            }}
          />
        ) : (
          <Fragment key={instance.instanceId}>
            <Lane label={instance.name} />
            {instance.rows.map((row) => modelRow(instance.providerId, row))}
          </Fragment>
        ),
      )}
    </SelectorShell>
  );
}
