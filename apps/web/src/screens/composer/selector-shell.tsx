import type { JSX, ReactNode } from "react";
import { Popover, PopoverContent, PopoverTrigger, cn } from "@hercule/ui";

const holdFocus = (event: Event): void => {
  event.preventDefault();
};

/**
 * One composer selector: a trigger and its menu, which opens above it.
 *
 * - The composer owns which selector is open and passes it in, so opening one
 *   selector closes any other. Radix handles Esc and outside clicks.
 * - `avoidCollisions` is off because every menu must open above its trigger.
 *   The composer sits at the bottom of the screen, so Radix's collision
 *   handling would flip these menus downwards, off the page. A trigger on the
 *   right therefore needs `align="end"` to stay on screen.
 * - A locked field is plain text with the reason as its tooltip, not a
 *   disabled button, because there is nothing left to open. Spec 14 §What
 *   locks at start lists the fields that lock once a thread starts.
 */
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
  /** The field's name, shown before the value on the lip's selectors. */
  readonly keyLabel?: string;
  readonly label: ReactNode;
  /** Why the field cannot be changed; null (the default) when it can. */
  readonly locked?: string | null;
  /** Disables the trigger, for a thread that takes no input at all. */
  readonly disabled?: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly align?: "start" | "end";
  readonly className?: string;
  readonly contentClassName?: string;
  /**
   * How far the menu is shifted along its aligned edge, in pixels. The
   * prototype does this when a menu would reach past something: the window
   * edge in the prototype, the model pill here.
   */
  readonly alignOffset?: number;
  /**
   * Handles Esc while the menu is open, for a menu where Esc should do
   * something other than close it, such as leave a form inside the menu first.
   * Calling `preventDefault` on the event keeps the menu open.
   */
  readonly onEscapeKeyDown?: ((event: KeyboardEvent) => void) | undefined;
  readonly children: ReactNode;
}): JSX.Element {
  // The space separates the key and the value in the accessible name. The
  // flex container does not render a whitespace-only node, so it adds no gap.
  const key =
    keyLabel === undefined ? null : (
      <>
        <span className="shrink-0 text-faint">{keyLabel}</span>{" "}
      </>
    );

  if (locked !== null) {
    // With a key label, the value gets its own span so the two are separate
    // parts. Without one, the value is not wrapped, so the same text does not
    // appear in two nested elements.
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
          {/* The value gets its own element, so a search for a menu row's
              text does not also match the trigger. `min-w-0` lets the value
              be truncated rather than widen the trigger past the space the
              card has for it. */}
          <span className="min-w-0">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align={align}
        alignOffset={alignOffset}
        avoidCollisions={false}
        // The current row is marked with its dot, not with a focus ring, as in
        // the prototype. So focus is not moved to the first row when the menu
        // opens. It stays on the trigger, or goes to a filter field that
        // focuses itself.
        onOpenAutoFocus={holdFocus}
        {...(onEscapeKeyDown === undefined ? {} : { onEscapeKeyDown })}
        // The menu is limited to the space above its trigger and scrolls
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
