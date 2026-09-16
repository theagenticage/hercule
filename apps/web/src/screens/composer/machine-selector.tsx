import type { JSX } from "react";
import type { MachineRow } from "@hydra/client-core";
import { cn } from "@hydra/ui";
import { MenuFoot, MenuHeader, MenuRow } from "./menu";
import { SelectorShell } from "./selector-shell";

/** Only `online` and `unreachable` carry a doctrine hue (live, failed); the rest are neutral. */
const STATE_HUE: Record<MachineRow["state"], string> = {
  online: "text-live",
  draining: "text-muted",
  retired: "text-muted",
  unreachable: "text-fail",
  offline: "text-muted",
};

/**
 * A row's first line: the machine, its state word in the state's hue, then
 * what else is true of it. The separating " · " is a text character in every
 * segment rather than a flex gap, so the row's own text - and a reader of it -
 * carries the spacing the eye sees.
 */
const rowLabel = (row: MachineRow): JSX.Element => (
  <span className="flex min-w-0 items-center">
    <span className="truncate">{row.name}</span>
    <span className={cn("shrink-0 whitespace-pre", STATE_HUE[row.state])}>{` · ${row.state}`}</span>
    {row.isLocal ? (
      <span className="shrink-0 text-faint whitespace-pre"> · this machine</span>
    ) : null}
    {row.reserved ? <span className="shrink-0 text-faint whitespace-pre"> · reserved</span> : null}
  </span>
);

/**
 * What stands under a row: who is logged in there and on what plan, and - on a
 * draft opening in a shared checkout - whether this machine holds the repo yet.
 * A machine that does not is still pickable: it clones on first use.
 */
const subLine = (row: MachineRow): JSX.Element => (
  <>
    <span className="block truncate">
      {[row.identity, row.planLabel].filter((each) => each !== null).join(" · ")}
    </span>
    {row.notCloned === null ? null : <span className="block truncate">{row.notCloned}</span>}
  </>
);

/**
 * The lip's right-hand selector: which machine a new thread is placed on,
 * scoped to the instance the model selector has already picked. Its own
 * trigger carries the label the field built - the machine in force, named with
 * the reason it is dimmed, because that reason is what stops the thread from
 * starting and the menu it is inside is shut.
 */
export function MachineSelector({
  rows,
  label,
  locked,
  open,
  onOpenChange,
  onPick,
}: {
  readonly rows: readonly MachineRow[];
  /** The machine in force, with the reason it is dimmed where there is one. */
  readonly label: string;
  readonly locked: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (runnerId: string) => void;
}): JSX.Element {
  return (
    <SelectorShell
      keyLabel="machine"
      label={label}
      locked={locked}
      open={open}
      onOpenChange={onOpenChange}
      align="end"
      contentClassName="w-[420px]"
    >
      <MenuHeader label="Machine" note="locks when the thread starts" />
      {rows.map((row) => (
        <MenuRow
          key={row.runnerId}
          name={rowLabel(row)}
          sub={subLine(row)}
          dimmed={row.dimmed}
          current={row.current}
          onPick={() => {
            onPick(row.runnerId);
            onOpenChange(false);
          }}
        />
      ))}
      <MenuFoot>
        <span>Add machine →</span>
        <span> · not built yet</span>
      </MenuFoot>
    </SelectorShell>
  );
}
