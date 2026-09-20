import { useState, type JSX } from "react";

const OPEN_KEY = "hercule.pulse.open";

/**
 * Whether the pulse is open, remembered for this browser session only.
 *
 * Reading and writing are both guarded: a browser with storage denied still
 * renders the pulse, it just forgets between page loads.
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
    // Nothing to do: the state is a convenience, not a record.
  }
};

/**
 * The fleet's ambient signals at the sidebar foot: one summary line that opens
 * to the full block. Closed by default; nothing reports into it yet, so both
 * states say so rather than showing an empty list.
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
        className="flex w-full cursor-pointer items-center gap-[7px] rounded-control px-2.5 py-1 text-left text-fine text-muted hover:bg-line-soft hover:text-ink aria-expanded:bg-line-soft aria-expanded:text-ink focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
      >
        <span className="size-1.5 shrink-0 rounded-full border-[1.5px] border-faint" />
        <span className="min-w-0 flex-1 truncate">Nothing to report yet</span>
        <span
          aria-hidden="true"
          className={`text-fine text-faint transition-transform ${open ? "rotate-90" : ""}`}
        >
          ›
        </span>
      </button>
      {open ? (
        <p className="pr-2.5 pb-0.5 pl-[23px] text-fine text-faint">
          Fleet, assistants and intake report here once a runner joins or a connection brings
          something in.
        </p>
      ) : null}
    </div>
  );
}
