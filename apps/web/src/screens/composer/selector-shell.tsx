import type { JSX, ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger, cn } from "@hydra/ui";

/**
 * One composer selector: a trigger and its menu, anchored above it. Which
 * selector is open is the composer's state, passed in rather than owned here,
 * so opening one closes whatever else was open; Esc and an outside click are
 * Radix's own behaviour, free once the pair is wired through.
 *
 * `avoidCollisions={false}` because every menu sits above its trigger,
 * unconditionally: the composer is at the foot of the screen, so Radix's own
 * collision avoidance would flip exactly these menus downwards off the page.
 * With collisions off, a right-hand trigger needs `align="end"` of its own to
 * stay on screen.
 *
 * A locked field is not a disabled button but plain text carrying the reason:
 * there is nothing behind it to open any more (spec 14 §What locks at start).
 */
export function SelectorShell({
  keyLabel,
  label,
  locked,
  disabled = false,
  open,
  onOpenChange,
  align = "start",
  variant = "field",
  className,
  contentClassName,
  onOpenAutoFocus,
  children,
}: {
  /** The field's own name, shown before the value on the lip's selectors. */
  readonly keyLabel?: string;
  readonly label: ReactNode;
  readonly locked: string | null;
  /** A thread that can take no input at all can change nothing about itself. */
  readonly disabled?: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly align?: "start" | "end";
  readonly variant?: "field" | "pill";
  readonly className?: string;
  readonly contentClassName?: string;
  readonly onOpenAutoFocus?: ((event: Event) => void) | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  // The space is what an accessible name reads between the two; a flex
  // container drops a whitespace-only node rather than laying it out.
  const key =
    keyLabel === undefined ? null : (
      <>
        <span className="shrink-0 text-faint">{keyLabel}</span>{" "}
      </>
    );

  if (locked !== null) {
    return (
      <span
        title={locked}
        className="inline-flex items-center gap-1.5 px-[7px] py-[3px] text-meta text-muted"
      >
        {key}
        <span>{label}</span>
      </span>
    );
  }

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "disabled:cursor-default disabled:text-faint disabled:hover:bg-transparent",
            "inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap",
            "after:text-[10px] after:text-faint after:content-['▾']",
            "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
            variant === "pill"
              ? "rounded-full border border-line bg-surface py-1 pr-[11px] pl-[9px] text-meta text-ink aria-expanded:border-faint [&>svg]:opacity-80"
              : "rounded-[5px] px-[7px] py-[3px] text-meta text-muted hover:bg-line-soft hover:text-ink aria-expanded:bg-line-soft aria-expanded:text-ink",
            className,
          )}
        >
          {key}
          {label}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align={align}
        avoidCollisions={false}
        onOpenAutoFocus={onOpenAutoFocus}
        className={cn("flex w-80 flex-col rounded-[10px] p-1.5 text-meta", contentClassName)}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
