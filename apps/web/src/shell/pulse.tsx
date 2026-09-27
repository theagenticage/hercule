import { useState, type JSX } from "react";

const OPEN_KEY = "hercule.pulse.open";

/**
 * Reads whether the pulse was left open in this browser session.
 *
 * Both this function and `writeOpen` catch storage errors. A browser that denies
 * storage still renders the pulse; it just forgets its state between page loads.
 */
const readOpen = (): boolean => {
  try {
    return window.sessionStorage.getItem(OPEN_KEY) === "true";
  } catch {
    return false;
  }
};

const writeOpen = (open: boolean): void => {
  try {
    window.sessionStorage.setItem(OPEN_KEY, String(open));
  } catch {
    // Ignore the error: losing this state is harmless.
  }
};

/**
 * The pulse at the foot of the sidebar: a one-line summary of the fleet's
 * signals that expands to the full block. It starts closed. Nothing reports
 * into it yet, so both the line and the block explain that instead of showing
 * an empty list.
 */
export function Pulse(): JSX.Element {
  const [open, setOpen] = useState(readOpen);

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    writeOpen(next);
  };

  return (
    <div className="flex flex-col gap-[3px] pb-1">
      <button
        type="button"
        aria-expanded={open}
        onClick={toggle}
        className="flex w-full cursor-pointer items-center gap-2 rounded-control px-2.5 py-1 text-left text-fine text-muted hover:bg-line-soft hover:text-ink aria-expanded:bg-line-soft aria-expanded:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
      >
        {/* The dot sits centred in a 12px slot, the width of the mark beside
            "Marks" below, so the two icons and the two labels line up. */}
        <span className="flex w-3 shrink-0 justify-center">
          <span className="size-1.5 rounded-full border-[1.5px] border-faint" />
        </span>
        <span className="min-w-0 flex-1 truncate">Nothing to report yet</span>
        <span
          aria-hidden="true"
          className={`text-fine text-faint transition-transform ${open ? "rotate-90" : ""}`}
        >
          ›
        </span>
      </button>
      {open ? (
        <p className="pr-2.5 pb-0.5 pl-[30px] text-fine text-faint">
          Fleet, assistants and intake report here once a runner joins or a connection brings
          something in.
        </p>
      ) : null}
    </div>
  );
}
