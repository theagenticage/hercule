/**
 * The shelf of a composer: the images attached to the message being written,
 * one tile each, above the message field.
 */
import { lazy, Suspense, useState, type JSX } from "react";
import {
  decideShelfTileState,
  formatAttachmentSize,
  type ShelfItem,
  type ShelfModel,
} from "@hercule/client-core";
import { CloseIcon } from "../../icons/close";
import { UndoIcon } from "../../icons/undo";
import { useBlobImageSource, useThumbnail } from "./thumbnail";
import "./attachments.css";

/** The size a shelf tile is drawn at, in CSS pixels. */
const TILE_SIZE = 64;

// The lightbox is a chunk of its own, loaded the first time an image is
// previewed (spec 17 §Performance, rule 6).
const ImageLightbox = lazy(() =>
  import("./image-lightbox").then((module) => ({ default: module.ImageLightbox })),
);

/**
 * Renders the shelf: one tile per image in `shelf`, in order, and the
 * lightbox while one of them is previewed. Renders nothing when `shelf` is
 * empty, so the card keeps its height.
 *
 * - A click on a tile shows it in the lightbox, which steps through the
 *   shelf.
 * - Each tile's remove button calls `onRemove` with its key.
 * - A failed tile's retry button calls `onRetry` with its key.
 * - When `model` does not accept images, every uploaded tile is marked,
 *   because none of them can be sent.
 */
export function AttachmentShelf({
  shelf,
  model,
  onRemove,
  onRetry,
}: {
  readonly shelf: readonly ShelfItem[];
  readonly model: ShelfModel;
  readonly onRemove: (key: string) => void;
  readonly onRetry: (key: string) => void;
}): JSX.Element | null {
  // The previewed image is held by its key, so the lightbox follows it when
  // an image before it is removed, and closes when it is removed itself.
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  if (shelf.length === 0) return null;
  const previewIndex = shelf.findIndex((item) => item.key === previewKey);
  const previewed = shelf[previewIndex];
  return (
    <>
      <ul className="shelf" aria-label="Attached images">
        {shelf.map((item) => (
          <ShelfTile
            key={item.key}
            item={item}
            model={model}
            onPreview={() => {
              setPreviewKey(item.key);
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
      {previewed === undefined ? null : (
        <Suspense fallback={null}>
          <ImageLightbox
            names={shelf.map((item) => item.name)}
            index={previewIndex}
            source={previewed.file}
            onIndexChange={(index) => {
              setPreviewKey(shelf[index]?.key ?? null);
            }}
            onClose={() => {
              setPreviewKey(null);
            }}
          />
        </Suspense>
      )}
    </>
  );
}

/**
 * Renders one tile: the thumbnail, as a button that previews the image, the
 * remove button in its corner, and the strip that names the upload's state.
 * The tile's tooltip names the image and its size, and the reason behind its
 * strip.
 */
function ShelfTile({
  item,
  model,
  onPreview,
  onRemove,
  onRetry,
}: {
  readonly item: ShelfItem;
  readonly model: ShelfModel;
  readonly onPreview: () => void;
  readonly onRemove: () => void;
  readonly onRetry: () => void;
}): JSX.Element {
  const thumbnail = useThumbnail(item.file, TILE_SIZE, TILE_SIZE);
  const image = useBlobImageSource(thumbnail);
  const state = decideShelfTileState(item, model);
  const title = [`${item.name} · ${formatAttachmentSize(item.sizeBytes)}`, state.reason]
    .filter((line) => line !== null)
    .join("\n");
  return (
    <li className="shelf-tile" data-status={state.name} title={title}>
      <button
        type="button"
        className="shelf-preview"
        aria-label={`Preview ${item.name}`}
        onClick={onPreview}
      >
        {thumbnail === undefined ? null : <img ref={image} alt="" draggable={false} />}
      </button>
      {state.strip === null ? null : (
        <span className="shelf-strip">
          <span className="shelf-strip-text">{state.strip}</span>
          {item.status === "failed" ? (
            <button
              type="button"
              className="shelf-retry"
              aria-label={`Retry upload for ${item.name}`}
              onClick={onRetry}
            >
              <UndoIcon size={11} />
            </button>
          ) : null}
        </span>
      )}
      <button
        type="button"
        className="shelf-remove"
        aria-label={`Remove ${item.name}`}
        onClick={onRemove}
      >
        <CloseIcon size={12} />
      </button>
    </li>
  );
}
