import type { JSX, ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger, cn } from "@hydra/ui";

/**
 * One composer selector: a trigger and a menu anchored above it. Every
 * selector shares one piece of state for which is open - passed in as `open`/
 * `onOpenChange` rather than owned here - so opening one closes whatever else
 * was open; Esc and an outside click are Radix's own `Popover` behaviour, free
 * once the pair is wired through like this.
 *
 * `avoidCollisions={false}` because AD-2 pins every selector's menu above its
 * trigger, unconditionally - a selector sitting close to the bottom of the
 * viewport (the setup bar) has less room below than above, and Radix's own
 * collision avoidance would otherwise flip exactly that one to the bottom.
 * With collisions off, a right-hand trigger needs `align="end"` of its own
 * accord to stay on screen - Radix will not pull it back once collision
 * avoidance is the very thing turned off.
 */
export function PopoverSelector({
  open,
  onOpenChange,
  trigger,
  disabled = false,
  align = "start",
  triggerClassName,
  contentClassName,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly trigger: ReactNode;
  /** A selector with nothing left to pick: the trigger is dead and reads as such. */
  readonly disabled?: boolean;
  readonly align?: "start" | "center" | "end";
  readonly triggerClassName?: string;
  readonly contentClassName?: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "rounded-control px-2 py-1 text-fine text-muted",
            "hover:bg-line-soft hover:text-ink",
            "disabled:cursor-default disabled:text-faint disabled:hover:bg-transparent",
            "disabled:hover:text-faint",
            "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
            triggerClassName,
          )}
        >
          {trigger}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align={align}
        avoidCollisions={false}
        className={cn("flex w-72 flex-col gap-1", contentClassName)}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
