import { useEffect, useRef, useState, type JSX, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "./cn";
import { useBlobImageSource } from "./blob-image";

/** One image the lightbox can show. A `blob` that is still loading is `null` or `undefined`. */
export interface LightboxImage {
  readonly key: string;
  readonly name: string;
  readonly blob: Blob | null | undefined;
}

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live";

/**
 * Shows one image of `images` large, over a scrim, with its name and place
 * ("shot.png (2/3)") under it. The caller mounts it to open it and unmounts
 * it to close it.
 *
 * - Escape, the close button and a click on the scrim call `onClose`.
 * - The left and right arrow keys, and the two arrow buttons, move to the
 *   previous and next image; they stop at the first and the last.
 * - It is modal: the focus moves into it when it opens, Tab and Shift+Tab
 *   stay inside it, and the focus goes back to where it was when it closes.
 *
 * The object URL is made only for the image on screen, so a bubble of ten
 * images holds one full-size URL at a time.
 */
export function ImageLightbox({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  readonly images: readonly LightboxImage[];
  readonly index: number;
  readonly onIndexChange: (index: number) => void;
  readonly onClose: () => void;
}): JSX.Element | null {
  const dialog = useRef<HTMLDivElement>(null);
  // Read while rendering the first time, before the dialog takes the focus.
  const [opener] = useState(() => document.activeElement);

  useEffect(() => {
    const node = dialog.current;
    node?.focus();
    return () => {
      // React's development mode runs this cleanup once while the dialog
      // stays on the page; the focus goes back only once it has left.
      queueMicrotask(() => {
        if (node?.isConnected !== true && opener instanceof HTMLElement) opener.focus();
      });
    };
  }, [opener]);

  // Moving to the last image disables Next. A focused button that becomes
  // disabled stops receiving keys, or loses the focus to the page, so the
  // arrow keys would stop working; the dialog takes the focus back instead.
  useEffect(() => {
    const node = dialog.current;
    const active = document.activeElement;
    const lost =
      !node?.contains(active) || (active instanceof HTMLButtonElement && active.disabled);
    if (node !== null && lost) node.focus();
  }, [index]);

  const image = images[index];
  if (image === undefined) return null;
  const hasPrevious = index > 0;
  const hasNext = index < images.length - 1;

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      // Stopped here so an overlay under the lightbox does not close as well.
      event.stopPropagation();
      onClose();
    } else if (event.key === "ArrowLeft" && hasPrevious) {
      onIndexChange(index - 1);
    } else if (event.key === "ArrowRight" && hasNext) {
      onIndexChange(index + 1);
    } else if (event.key === "Tab") {
      keepFocusInside(event);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim-strong"
      onClick={onClose}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label={`${image.name} (${String(index + 1)}/${String(images.length)})`}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
        onClick={(event) => {
          event.stopPropagation();
        }}
        className="flex max-w-[92vw] flex-col items-center gap-2.5 outline-none"
      >
        <LightboxPicture image={image} />
        <div className="flex max-w-full items-center gap-1 rounded-control border border-line bg-raised px-1 py-0.5 shadow-lift">
          {images.length > 1 ? (
            <LightboxButton
              label="Previous image"
              disabled={!hasPrevious}
              onClick={() => {
                onIndexChange(index - 1);
              }}
            >
              <path d="M7.5 2.5 4 6l3.5 3.5" />
            </LightboxButton>
          ) : null}
          <span className="min-w-0 truncate px-1.5 text-meta text-ink">
            {image.name}{" "}
            <span className="font-mono text-faint tabular-nums">
              ({index + 1}/{images.length})
            </span>
          </span>
          {images.length > 1 ? (
            <LightboxButton
              label="Next image"
              disabled={!hasNext}
              onClick={() => {
                onIndexChange(index + 1);
              }}
            >
              <path d="M4.5 2.5 8 6 4.5 9.5" />
            </LightboxButton>
          ) : null}
          <span aria-hidden="true" className="mx-0.5 h-3.5 w-px bg-line" />
          <LightboxButton label="Close" disabled={false} onClick={onClose}>
            <path d="m3 3 6 6M9 3l-6 6" />
          </LightboxButton>
        </div>
      </div>
    </div>
  );
}

/** Shows the image at its own size, shrunk to fit 92% of the window's width and 86% of its height. */
function LightboxPicture({ image }: { readonly image: LightboxImage }): JSX.Element {
  const source = useBlobImageSource(image.blob);
  if (image.blob === null || image.blob === undefined) {
    return (
      <div className="flex size-64 items-center justify-center rounded-card border border-line bg-raised text-meta text-faint shadow-lift">
        Loading…
      </div>
    );
  }
  return (
    <img
      ref={source}
      alt={image.name}
      className="block max-h-[86vh] max-w-[92vw] rounded-card border border-line bg-raised object-contain shadow-lift"
    />
  );
}

function LightboxButton({
  label,
  disabled,
  onClick,
  children,
}: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onClick: () => void;
  /** The 12px mark, drawn as paths in the marks family. */
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-control text-muted",
        "enabled:hover:bg-line-soft enabled:hover:text-ink disabled:cursor-default disabled:text-faint/60",
        FOCUS_RING,
      )}
    >
      <svg
        viewBox="0 0 12 12"
        width={12}
        height={12}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.15}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {children}
      </svg>
    </button>
  );
}

/**
 * Moves the focus from the last usable control inside the dialog to the
 * first on Tab, and from the first to the last on Shift+Tab, so the focus
 * never reaches the page behind the lightbox.
 */
function keepFocusInside(event: KeyboardEvent<HTMLDivElement>): void {
  const controls = [
    ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"),
  ];
  const first = controls[0];
  const last = controls.at(-1);
  if (first === undefined || last === undefined) return;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || active === event.currentTarget)) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}
