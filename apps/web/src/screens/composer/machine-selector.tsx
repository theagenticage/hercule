import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import type { MachineRow } from "@hydra/client-core";
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
 * A row's first line at the right: the state word in the state's hue, then how
 * much of the machine is taken. Nothing else is said there - what is true of
 * the machine belongs under it, where there is room for the reason.
 */
const stateAndCapacity = (row: MachineRow): JSX.Element => (
  <>
    <span className={STATE_HUE[row.state]}>{row.state}</span>
    {/* The space is a character rather than a gap, so the row reads the way
        it looks to a reader who hears it rather than sees it. */}
    <span className="font-mono whitespace-pre text-faint tabular-nums">{` ${row.capacity}`}</span>
  </>
);

/**
 * What stands under a row: what this machine is - the local one, the one a new
 * thread lands on, one held back - and every reason it is dimmed. A machine
 * that does not hold the repo yet is still pickable: it clones on first use.
 */
const subLine = (row: MachineRow): string =>
  [
    row.isLocal ? "this machine" : null,
    row.isDefault ? "default" : null,
    row.reserved ? "reserved" : null,
    row.dimmed,
    row.notCloned,
  ]
    .filter((each): each is string => each !== null)
    .join(" · ");

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
          name={row.name}
          note={stateAndCapacity(row)}
          sub={subLine(row)}
          inert={row.dimmed !== null}
          current={row.current}
          onPick={() => {
            onPick(row.runnerId);
            onOpenChange(false);
          }}
        />
      ))}
      <MenuFoot>
        The thread runs where you say; nothing moves it later.{" "}
        <Link to="/fleet" className="text-muted hover:text-ink">
          Add machine →
        </Link>
      </MenuFoot>
    </SelectorShell>
  );
}
