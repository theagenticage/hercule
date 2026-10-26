/**
 * Puts text on the system clipboard, from a click.
 *
 * `navigator.clipboard` exists only in a secure context: HTTPS, or localhost.
 * Hercule is self-hosted and often opened over plain HTTP on a LAN, where
 * `navigator.clipboard` is undefined. There the browser's copy command still
 * works inside a click, and a `copy` listener decides what it puts on the
 * clipboard.
 */

/**
 * Copies `text` to the clipboard as plain text. Resolves to true when the copy
 * happened, and to false when the browser refused. It never rejects. Call it
 * synchronously from a user gesture such as a click handler, or the browser
 * refuses.
 *
 * Without `navigator.clipboard`, the copy command runs before this function
 * returns, so it still counts as part of the click. Its listener sits on the
 * capture phase of the document and stops the event, so an editor with the
 * focus cannot replace `text` with its own selection. The listener is removed
 * before this function returns, whether or not the event fired.
 */
export function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText !== undefined) {
    return navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
  }
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
    return Promise.resolve(document.execCommand("copy") && supplied);
  } catch {
    return Promise.resolve(false);
  } finally {
    document.removeEventListener("copy", supplyClipboardText, { capture: true });
  }
}
