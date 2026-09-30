import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { describeMachineRow, type MachineRow } from "@hercule/client-core";
import { MenuFoot, MenuHeader, MenuRow } from "./menu";
import { SelectorShell } from "./selector-shell";

/**
 * The text colour per machine state. Only `online` (live) and `unreachable`
 * (failed) get a colour; the rest are neutral.
 */
const STATE_HUE: Record<MachineRow["state"], string> = {
  online: "text-live",
  draining: "text-muted",
  unreachable: "text-fail",
  offline: "text-muted",
};

/**
 * Renders the right-hand note on a machine row: the state in its colour, then
 * how much of the machine's capacity is in use. Everything else about the
 * machine goes on the line below, where there is room for a reason.
 */
const renderStateAndCapacity = (row: MachineRow): JSX.Element => (
  <>
    <span className={STATE_HUE[row.state]}>{row.state}</span>
    {/* The space is a real character rather than a CSS gap, so a screen
        reader reads the state and capacity as two words. */}
    <span className="font-mono whitespace-pre text-faint tabular-nums">{` ${row.capacity}`}</span>
  </>
);

/**
 * The lip's right-hand selector: the machine a new thread is placed on,
 * limited to machines for the provider instance picked in the model selector.
 *
 * The trigger shows the current machine together with the reason it is dimmed,
 * if any. That reason is what blocks the thread from starting, and it must be
 * visible while the menu is closed.
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
  /** The current machine's name, followed by the reason it is dimmed, if any. */
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
          note={renderStateAndCapacity(row)}
          sub={describeMachineRow(row)}
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
