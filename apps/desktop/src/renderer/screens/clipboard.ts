/**
 * Puts text on the system clipboard, from a click.
 *
 * Why not `navigator.clipboard.writeText`: main grants the renderer no
 * permission at all (spec 17, Security), and Chromium refuses that call
 * without the `clipboard-sanitized-write` permission. The browser's copy
 * command needs no permission, only the click that runs it, and a `copy`
 * listener decides what it puts on the clipboard.
 */

/**
 * Copies `text` to the clipboard as plain text. Returns true when the copy
 * happened, and false when the browser refused. It must run inside a user
 * gesture, such as a click handler, or the browser refuses.
 *
 * The listener sits on the capture phase of the document and stops the event,
 * so an editor with the focus cannot replace `text` with its own selection.
 * It is removed again before this returns, whether or not the event fired.
 */
export function copyText(text: string): boolean {
  let supplied = false;
  const supplyClipboardText = (event: ClipboardEvent): void => {
    if (event.clipboardData === null) return;
    event.clipboardData.setData("text/plain", text);
    event.preventDefault();
    event.stopImmediatePropagation();
    supplied = true;
  };
  document.addEventListener("copy", supplyClipboardText, { capture: true });
  try {
    return document.execCommand("copy") && supplied;
  } finally {
    document.removeEventListener("copy", supplyClipboardText, { capture: true });
  }
}
