import type { JSX } from "react";
import {
  decideShelfTileState,
  formatAttachmentSize,
  type ShelfItem,
  type ShelfModel,
  type ShelfTileState,
} from "@hercule/client-core";
import { cn, useBlobImageSource } from "@hercule/ui";

const FOCUS_RING =
  "focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live";

/** The colour of each strip's words: the upload's progress is muted, and a problem stands out. */
const STRIP_TONE: Record<ShelfTileState["name"], string> = {
  uploading: "text-muted",
  uploaded: "text-muted",
  failed: "text-fail",
  expired: "text-attn",
  unsupported: "text-attn",
  "too-large": "text-attn",
};

/**
 * Renders the images attached to the message, as a row of 64px thumbnails
 * above the text. Renders nothing when no image is attached, so the card
 * keeps its height.
 *
 * Each thumbnail opens the preview, has a remove button, and shows a strip
 * along its bottom while it needs attention: uploading, failed with a retry
 * button, expired, or not accepted by `model`. The name, the size and the
 * reason behind the strip are in the thumbnail's tooltip.
 */
export function AttachmentShelf({
  shelf,
  model,
  onPreview,
  onRemove,
  onRetry,
}: {
  readonly shelf: readonly ShelfItem[];
  /** The selected model; when it does not accept images, every uploaded thumbnail is marked. */
  readonly model: ShelfModel;
  /** Called with the position of the thumbnail the user clicked. */
  readonly onPreview: (index: number) => void;
  readonly onRemove: (key: string) => void;
  readonly onRetry: (key: string) => void;
}): JSX.Element | null {
  if (shelf.length === 0) return null;
  return (
    <ul aria-label="Attached images" className="flex flex-wrap gap-2">
      {shelf.map((item, index) => (
        <ShelfThumbnail
          key={item.key}
          item={item}
          state={decideShelfTileState(item, model)}
          onPreview={() => {
            onPreview(index);
          }}
          onRemove={() => {
            onRemove(item.key);
          }}
          onRetry={() => {
            onRetry(item.key);
          }}
        />
      ))}
    </ul>
  );
}

function ShelfThumbnail({
  item,
  state,
  onPreview,
  onRemove,
  onRetry,
}: {
  readonly item: ShelfItem;
  readonly state: ShelfTileState;
  readonly onPreview: () => void;
  readonly onRemove: () => void;
  readonly onRetry: () => void;
}): JSX.Element {
  // The image shows from memory, so the thumbnail appears before the upload ends.
  const source = useBlobImageSource(item.file);
  return (
    <li
      className="relative size-16 shrink-0"
      title={[`${item.name} · ${formatAttachmentSize(item.sizeBytes)}`, state.reason]
        .filter((line) => line !== null)
        .join("\n")}
    >
      <button
        type="button"
        aria-label={`Preview ${item.name}`}
        onClick={onPreview}
        className={cn(
          "block size-full cursor-zoom-in overflow-hidden rounded-control border border-line bg-surface",
          FOCUS_RING,
        )}
      >
        <img
          ref={source}
          alt=""
          decoding="async"
          className={cn("size-full object-cover", state.name === "uploaded" ? null : "opacity-55")}
        />
      </button>
      {state.strip === null ? null : (
        <span
          className={cn(
            "pointer-events-none absolute inset-x-px bottom-px flex h-5 items-center justify-center gap-1 rounded-b-[5px] bg-raised px-0.5 text-[10px] leading-none whitespace-nowrap",
            STRIP_TONE[state.name],
          )}
        >
          {state.strip}
          {state.name === "failed" ? <RetryButton name={item.name} onRetry={onRetry} /> : null}
        </span>
      )}
      <button
        type="button"
        aria-label={`Remove ${item.name}`}
        onClick={onRemove}
        className={cn(
          "absolute top-1 right-1 inline-flex size-5 cursor-pointer items-center justify-center rounded-full bg-black/60 text-white ring-1 ring-white/45 hover:bg-black/80",
          FOCUS_RING,
        )}
      >
        <svg viewBox="0 0 12 12" width={12} height={12} fill="none" aria-hidden="true">
          <path
            d="m3.5 3.5 5 5m0-5-5 5"
            stroke="currentColor"
            strokeWidth={1.3}
            strokeLinecap="round"
          />
        </svg>
      </button>
    </li>
  );
}

/** Renders the retry button on a failed thumbnail's strip: a 20px target around an 11px arrow. */
function RetryButton({
  name,
  onRetry,
}: {
  readonly name: string;
  readonly onRetry: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={`Retry upload for ${name}`}
      title="Retry"
      onClick={onRetry}
      className={cn(
        "pointer-events-auto -mr-1 inline-flex size-5 cursor-pointer items-center justify-center rounded-full text-muted hover:bg-line-soft hover:text-ink",
        FOCUS_RING,
      )}
    >
      <svg viewBox="0 0 12 12" width={11} height={11} fill="none" aria-hidden="true">
        <path
          d="M9.6 6.4A3.6 3.6 0 1 1 8.4 3.3M9 1.6v2.2H6.8"
          stroke="currentColor"
          strokeWidth={1.2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
}

/**
 * Covers the composer card while images are dragged over it: a dashed
 * outline and "Drop images to attach". It takes no pointer events, so the
 * card under it keeps receiving the drag.
 */
export function DropOverlay(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute -inset-px z-[2] flex items-center justify-center rounded-[14px] border-[1.5px] border-dashed border-live bg-raised text-row text-muted"
    >
      Drop images to attach
    </div>
  );
}
