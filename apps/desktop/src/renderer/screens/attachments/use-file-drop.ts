import { useRef, useState, type DragEvent } from "react";

/** The handlers `useFileDrop` puts on the element files are dropped on. */
export interface FileDropHandlers {
  readonly onDragEnter: (event: DragEvent<HTMLElement>) => void;
  readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
  readonly onDragLeave: (event: DragEvent<HTMLElement>) => void;
  readonly onDrop: (event: DragEvent<HTMLElement>) => void;
}

/** Checks that a drag carries files, rather than text or a link. */
const carriesFiles = (event: DragEvent<HTMLElement>): boolean =>
  event.dataTransfer.types.includes("Files");

/**
 * Lets the user drop files on an element. Returns whether files are being
 * dragged over it, to draw the drop overlay, and the handlers to put on it.
 * A drop calls `onFiles` with the dropped files, all of them: the caller
 * refuses the ones it cannot take, and says why.
 *
 * A drag that carries no files, such as selected text, is left to the
 * browser. With `enabled` false, nothing is taken.
 */
export function useFileDrop(
  enabled: boolean,
  onFiles: (files: readonly File[]) => void,
): { readonly dragging: boolean; readonly handlers: FileDropHandlers } {
  const [dragging, setDragging] = useState(false);
  // `dragleave` also fires when the pointer moves from the element onto one
  // of its children, so the drag is over the element until as many leaves
  // as enters have fired.
  const depthRef = useRef(0);

  const handlers: FileDropHandlers = {
    onDragEnter: (event) => {
      if (!enabled || !carriesFiles(event)) return;
      event.preventDefault();
      depthRef.current += 1;
      setDragging(true);
    },
    onDragOver: (event) => {
      if (!enabled || !carriesFiles(event)) return;
      // Without this, the browser refuses the drop.
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (event) => {
      if (!enabled || !carriesFiles(event)) return;
      depthRef.current = Math.max(0, depthRef.current - 1);
      if (depthRef.current === 0) setDragging(false);
    },
    onDrop: (event) => {
      if (!enabled || !carriesFiles(event)) return;
      event.preventDefault();
      depthRef.current = 0;
      setDragging(false);
      onFiles([...event.dataTransfer.files]);
    },
  };
  return { dragging: enabled && dragging, handlers };
}
