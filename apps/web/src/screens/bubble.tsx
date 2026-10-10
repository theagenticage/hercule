import { useState, type JSX, type Ref } from "react";
import { cn, ImageLightbox, useBlobImageSource, type LightboxImage } from "@hercule/ui";
import { Markdown } from "./markdown";

/**
 * Renders one message sent into a thread, in a bubble: a message the owner
 * or another session's agent sent into a turn, or the owner's message in an
 * assistant's conversation. The caller places the bubble on the right, and
 * draws who sent it, when that is not the owner, around it.
 *
 * The bubble is a passive container, so it sits on `--surface` with a
 * `--line` hairline, as design-language.md asks; the lit `--raised` layer is
 * kept for what needs attention. A newline the user typed (Shift+Enter) is
 * deliberate, so the text keeps its line breaks.
 *
 * The images attached to the message sit above the text, two to a row, and
 * a click on one opens it large. A message may be images alone, with no text.
 */
export function MessageBubble({
  text,
  images = [],
  imagesRef,
}: {
  readonly text: string;
  /** The message's images, in the order they were attached; a blob still loading is undefined. */
  readonly images?: readonly LightboxImage[];
  /** The ref for the images' grid, so the caller can read their bytes once the grid is on screen. */
  readonly imagesRef?: Ref<HTMLDivElement>;
}): JSX.Element {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <div className="max-w-[80%] rounded-card border border-line bg-surface px-3.5 py-2 text-row text-ink">
      {images.length === 0 ? null : (
        <div
          ref={imagesRef}
          className={cn(
            // Each image is at most 210px wide, so one image is 210px and two are 210px each.
            "grid max-w-full gap-1.5",
            images.length === 1
              ? "w-[210px] grid-cols-1"
              : "w-[426px] grid-cols-[repeat(2,minmax(0,1fr))]",
            // The text's blocks are the bubble's own children, so the gap above them is a margin here.
            text === "" ? null : "mb-2",
          )}
        >
          {images.map((image, index) => (
            <BubbleImage
              key={image.key}
              image={image}
              onOpen={() => {
                setOpen(index);
              }}
            />
          ))}
        </div>
      )}
      <Markdown text={text} breaks />
      {open === null ? null : (
        <ImageLightbox
          images={images}
          index={open}
          onIndexChange={setOpen}
          onClose={() => {
            setOpen(null);
          }}
        />
      )}
    </div>
  );
}

function BubbleImage({
  image,
  onOpen,
}: {
  readonly image: LightboxImage;
  readonly onOpen: () => void;
}): JSX.Element {
  const source = useBlobImageSource(image.blob);
  return (
    <button
      type="button"
      aria-label={`Preview ${image.name}`}
      title={image.name}
      onClick={onOpen}
      className="block aspect-[4/3] w-full cursor-zoom-in overflow-hidden rounded-control border border-line bg-raised focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-live"
    >
      <img ref={source} alt="" decoding="async" className="size-full object-cover" />
    </button>
  );
}
