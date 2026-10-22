import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

/**
 * Stands in for the browser's copy command. `fires` is whether the command
 * dispatches a `copy` event, and `copies` what it returns.
 */
const stubCopyCommand = ({ fires, copies }: { fires: boolean; copies: boolean }) => {
  const clipboard = new Map<string, string>();
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: vi.fn(() => {
      if (fires) {
        const event = new Event("copy", { cancelable: true }) as ClipboardEvent;
        Object.defineProperty(event, "clipboardData", {
          value: { setData: (type: string, text: string) => clipboard.set(type, text) },
        });
        document.dispatchEvent(event);
      }
      return copies;
    }),
  });
  return clipboard;
};

describe("copyText", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("puts the text on the clipboard as plain text and says so", () => {
    const clipboard = stubCopyCommand({ fires: true, copies: true });

    expect(copyText("a $review b")).toBe(true);
    expect(clipboard.get("text/plain")).toBe("a $review b");
  });

  it("keeps a listener of the page from replacing the text", () => {
    const clipboard = stubCopyCommand({ fires: true, copies: true });
    const pageListener = vi.fn<(event: Event) => void>();
    document.addEventListener("copy", pageListener);

    copyText("mine");

    document.removeEventListener("copy", pageListener);
    expect(pageListener).not.toHaveBeenCalled();
    expect(clipboard.get("text/plain")).toBe("mine");
  });

  it("fails when the browser refuses the command", () => {
    stubCopyCommand({ fires: true, copies: false });

    expect(copyText("x")).toBe(false);
  });

  it("fails when the command never reaches the page's copy event", () => {
    stubCopyCommand({ fires: false, copies: true });

    expect(copyText("x")).toBe(false);
  });

  it.each([
    ["the copy happened", { fires: true, copies: true }],
    ["the browser refused", { fires: true, copies: false }],
    ["no copy event came", { fires: false, copies: true }],
  ])("leaves no listener behind when %s", (_case, command) => {
    stubCopyCommand(command);
    copyText("mine");

    // A later copy by the user must reach the page as it is, with its own data.
    const later = new Event("copy", { cancelable: true }) as ClipboardEvent;
    const setData = vi.fn<(type: string, text: string) => void>();
    Object.defineProperty(later, "clipboardData", { value: { setData } });
    document.dispatchEvent(later);

    expect(setData).not.toHaveBeenCalled();
    expect(later.defaultPrevented).toBe(false);
  });
});
