import type { JSX, ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger, cn } from "@hercule/ui";

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
const holdFocus = (event: Event): void => {
  event.preventDefault();
};

export function SelectorShell({
  keyLabel,
  label,
  locked = null,
  disabled = false,
  open,
  onOpenChange,
  align = "start",
  className,
  contentClassName,
  alignOffset = 0,
  onEscapeKeyDown,
  children,
}: {
  /** The field's own name, shown before the value on the lip's selectors. */
  readonly keyLabel?: string;
  readonly label: ReactNode;
  /** Why this cannot be changed here; nothing locks a field that never locks. */
  readonly locked?: string | null;
  /** A thread that can take no input at all can change nothing about itself. */
  readonly disabled?: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly align?: "start" | "end";
  readonly className?: string;
  readonly contentClassName?: string;
  /**
   * How far along its own edge the menu is nudged, in pixels: what the
   * prototype does when a menu anchored at its trigger would reach past
   * something - the window's edge there, the model pill here.
   */
  readonly alignOffset?: number;
  /**
   * What Esc means while this menu is open, where it means something other
   * than closing it - a form inside it to leave first. Preventing the event's
   * default keeps the menu open.
   */
  readonly onEscapeKeyDown?: ((event: KeyboardEvent) => void) | undefined;
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
    // A field with a key word reads as two parts, so the value keeps a span of
    // its own; one without reads as a single value, and wrapping it would make
    // the same text stand in two nested elements.
    return (
      <span
        title={locked}
        className="inline-flex items-center gap-[5px] px-[7px] py-[3px] text-meta text-muted"
      >
        {key === null ? (
          label
        ) : (
          <>
            {key}
            <span>{label}</span>
          </>
        )}
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
            "inline-flex cursor-pointer items-center gap-[5px] whitespace-nowrap",
            "after:text-[10px] after:text-faint after:content-['▾']",
            "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live",
            "rounded-[5px] px-[7px] py-[3px] text-meta text-muted",
            "hover:bg-line-soft hover:text-ink aria-expanded:bg-line-soft aria-expanded:text-ink",
            className,
          )}
        >
          {key}
          {/* The value stands in an element of its own, so a reader asking
              for a menu row's text does not also find the trigger the row
              would change. `min-w-0` lets it be clipped rather than grow the
              trigger past the room the card has for it. */}
          <span className="min-w-0">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align={align}
        alignOffset={alignOffset}
        avoidCollisions={false}
        // Opening a menu marks the row in force with its dot; it does not also
        // ring the row, as the prototype's menus do not. Focus stays where the
        // user put it - on the trigger, or in a filter field that asks for it
        // itself - rather than being moved onto the first row.
        onOpenAutoFocus={holdFocus}
        {...(onEscapeKeyDown === undefined ? {} : { onEscapeKeyDown })}
        // The menu opens upwards into the room above its trigger and scrolls
        // inside it, rather than growing off the top of the window.
        className={cn(
          "flex max-h-[calc(var(--radix-popover-content-available-height)-10px)] w-80 flex-col",
          "overflow-y-auto rounded-[10px] p-1.5 text-meta",
          contentClassName,
        )}
      >
        {children}
      </PopoverContent>
    </Popover>
  );
}
