import { useEffect, useRef, useState, type JSX } from "react";
import { cn } from "@hercule/ui";
import { copyText } from "./clipboard";

/** How long a copy button shows its result before it returns to its normal look. */
const COPY_RESULT_MS = 1500;

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live";

// Both buttons are the same small square and never shrink, so a long language
// name cannot push them out of the header.
const HEADER_BUTTON = cn(
  "flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-control text-faint",
  "hover:bg-line-soft hover:text-ink",
  FOCUS_RING,
);

const ICON_PROPS = {
  viewBox: "0 0 14 14",
  width: 14,
  height: 14,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

/** Renders a line of text that continues on a second line, ending in a return arrow. */
function WrapIcon(): JSX.Element {
  return (
    <svg {...ICON_PROPS}>
      <path d="M2 3.5h10M2 10.5h3M2 7h8.5a1.75 1.75 0 0 1 0 3.5H8.5M9.8 9.2 8.5 10.5l1.3 1.3" />
    </svg>
  );
}

/** Renders two overlapping pages. */
function CopyIcon(): JSX.Element {
  return (
    <svg {...ICON_PROPS}>
      <rect x="5" y="5" width="7" height="7" rx="1.5" />
      <path d="M9 3.3V3.2A1.2 1.2 0 0 0 7.8 2H3.2A1.2 1.2 0 0 0 2 3.2v4.6A1.2 1.2 0 0 0 3.2 9h.1" />
    </svg>
  );
}

/** Renders a check mark. */
function CheckIcon(): JSX.Element {
  return (
    <svg {...ICON_PROPS}>
      <path d="m3 7.5 2.8 2.8L11 4.2" />
    </svg>
  );
}

/**
 * Draws a fenced code block as a card: a slim header row, then the code.
 *
 * The header shows the fence's `language` on the left, when there is one. On the right are a wrap toggle and a copy button, which are always
 * visible. Lines wrap by default; the toggle turns wrapping off for this block
 * only, and the choice is not remembered. With wrapping off, only the code
 * scrolls sideways, and the header stays put.
 *
 * Copy puts `text` on the clipboard exactly as given. For 1.5 seconds after a
 * click, the button reads "Copied" or "Copy failed", and a hidden live region
 * announces the same words to a screen reader.
 *
 * Draw it with a stable React key: a key that changes with the text would
 * remount the block and reset its wrap choice while an answer streams in.
 */
export function CodeBlock({
  text,
  language,
  className,
}: {
  readonly text: string;
  /** The first word of the fence's info string. Absent for a fence without one, indented code and HTML. */
  readonly language?: string | undefined;
  /** Spacing around the card, set by the caller. */
  readonly className?: string;
}): JSX.Element {
  const [wraps, setWraps] = useState(true);
  // A new object on every click, so a second click restarts the timer even
  // when it has the same result as the first.
  const [copyResult, setCopyResult] = useState<{ readonly copied: boolean } | null>(null);

  // Counts clicks, so a copy that finishes after a newer click is ignored.
  const latestCopy = useRef(0);

  useEffect(() => {
    if (copyResult === null) return;
    const timer = setTimeout(() => {
      setCopyResult(null);
    }, COPY_RESULT_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [copyResult]);

  const copyLabel =
    copyResult === null ? "Copy code" : copyResult.copied ? "Copied" : "Copy failed";

  return (
    <div
      className={cn("overflow-hidden rounded-card border border-line-soft bg-surface", className)}
    >
      <div className="flex items-center gap-0.5 pt-1.5 pr-2 pl-3 font-mono text-fine text-faint">
        <span className="min-w-0 flex-1 truncate pr-2">{language}</span>
        <button
          type="button"
          aria-pressed={wraps}
          aria-label="Wrap lines"
          title="Wrap lines"
          onClick={() => {
            setWraps((current) => !current);
          }}
          className={cn(HEADER_BUTTON, wraps && "bg-line text-ink hover:bg-line")}
        >
          <WrapIcon />
        </button>
        <button
          type="button"
          aria-label={copyLabel}
          title={copyLabel}
          onClick={() => {
            // `copyText` must start inside the click, so it is called here and
            // only its result waits.
            const thisCopy = ++latestCopy.current;
            void copyText(text).then((copied) => {
              if (thisCopy === latestCopy.current) setCopyResult({ copied });
            });
          }}
          className={cn(HEADER_BUTTON, copyResult?.copied === false && "text-fail")}
        >
          {copyResult?.copied === true ? <CheckIcon /> : <CopyIcon />}
        </button>
        <span role="status" className="sr-only">
          {copyResult === null ? "" : copyLabel}
        </span>
      </div>
      <pre
        className={cn(
          "px-3 pt-1 pb-2.5 font-mono text-fine leading-relaxed",
          wraps ? "wrap-anywhere whitespace-pre-wrap" : "overflow-x-auto whitespace-pre",
        )}
      >
        <code>{text}</code>
      </pre>
    </div>
  );
}
