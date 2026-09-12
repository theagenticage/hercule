import type { JSX } from "react";
import type { RunnerMenuRow } from "@hydra/client-core";
import { cn } from "@hydra/ui";
import { MenuFoot, MenuHeader, MenuRow } from "./menu-row";
import { SelectorShell } from "./selector-shell";

/** Only `online` and `unreachable` carry a doctrine hue (live, failed); the rest are neutral. */
const STATE_HUE: Record<RunnerMenuRow["state"], string> = {
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
const rowLabel = (row: RunnerMenuRow): JSX.Element => (
  <span className="flex min-w-0 items-center">
    <span className="truncate">{row.name}</span>
    <span className={cn("shrink-0", STATE_HUE[row.state])}>{` · ${row.state}`}</span>
    {row.isLocal ? <span className="shrink-0 text-faint"> · this machine</span> : null}
    {row.reserved ? <span className="shrink-0 text-faint"> · reserved</span> : null}
  </span>
);

/**
 * The lip's right-hand selector: which machine a new thread is placed on,
 * scoped to the instance the model selector has already picked.
 *
 * Its own trigger names the reason the picked machine is dimmed, because that
 * reason is what stops the thread from starting and the menu it is inside is
 * shut.
 */
export function MachineSelector({
  rows,
  name,
  referenceId,
  runnerId,
  locked,
  open,
  onOpenChange,
  onPick,
}: {
  readonly rows: readonly RunnerMenuRow[];
  /** What the machine in force is called, which is a fact of the field, not of a row. */
  readonly name: string;
  /** The machine the trigger speaks about when none is picked yet. */
  readonly referenceId: string | null;
  /** The machine picked, which marks the row; none picked marks no row. */
  readonly runnerId: string | null;
  readonly locked: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (runnerId: string) => void;
}): JSX.Element {
  // The name and the reason come off one row, never off two: a machine named
  // with another's reason would send the user to fix the wrong thing.
  const spoken = rows.find((row) => row.runnerId === (runnerId ?? referenceId));
  const label =
    spoken?.dimmed === undefined || spoken.dimmed === null ? name : `${name} · ${spoken.dimmed}`;

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
          sub={[row.identity, row.planLabel].filter((each) => each !== null).join(" · ")}
          dimmed={row.dimmed}
          current={row.runnerId === runnerId}
          onPick={() => {
            onPick(row.runnerId);
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
