import type { JSX, ReactNode } from "react";
import { PopoverSelector } from "./popover-selector";

/**
 * One field of the setup bar (workspace, checkout, branch, runner, profile):
 * a live `PopoverSelector` before a thread starts, a plain locked value after
 * - the same choice every field in the bar makes.
 */
export function SetupField({
  started,
  lockedText,
  open,
  onOpenChange,
  trigger,
  children,
}: {
  readonly started: boolean;
  readonly lockedText: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly trigger: string;
  readonly children: ReactNode;
}): JSX.Element {
  if (started) return <span className="px-2 py-1">{lockedText}</span>;
  return (
    <PopoverSelector open={open} onOpenChange={onOpenChange} trigger={trigger}>
      {children}
    </PopoverSelector>
  );
}
