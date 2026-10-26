import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./clipboard";

/**
 * Stands in for the browser's copy command, the path taken without
 * `navigator.clipboard`. `fires` is whether the command dispatches a `copy`
 * event, and `copies` what it returns. A command given `throws` throws instead.
 */
const stubCopyCommand = ({
  fires,
  copies,
  throws = false,
}: {
  fires: boolean;
  copies: boolean;
  throws?: boolean;
}) => {
  const clipboard = new Map<string, string>();
  const execCommand = vi.fn(() => {
    if (throws) throw new Error("not allowed");
    if (fires) {
      const event = new Event("copy", { cancelable: true }) as ClipboardEvent;
      Object.defineProperty(event, "clipboardData", {
        value: { setData: (type: string, text: string) => clipboard.set(type, text) },
      });
      document.dispatchEvent(event);
    }
    return copies;
  });
  Object.defineProperty(document, "execCommand", { configurable: true, value: execCommand });
  return { clipboard, execCommand };
};

describe("copyText with navigator.clipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("writes the text and reports success", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(copyText("a $review b")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("a $review b");
  });

  it("reports failure when the browser rejects the write", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: () => Promise.reject(new Error("no")) } });

    await expect(copyText("x")).resolves.toBe(false);
  });
});

// Over plain HTTP on a LAN, `navigator.clipboard` is undefined.
describe("copyText without navigator.clipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("puts the text on the clipboard as plain text and reports success", async () => {
    vi.stubGlobal("navigator", {});
    const { clipboard } = stubCopyCommand({ fires: true, copies: true });

    await expect(copyText("a $review b")).resolves.toBe(true);
    expect(clipboard.get("text/plain")).toBe("a $review b");
  });

  it("runs the copy command before returning, inside the click", () => {
    vi.stubGlobal("navigator", {});
    const execCommand = stubCopyCommand({ fires: true, copies: true }).execCommand;

    void copyText("x");

    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("keeps a listener of the page from replacing the text", async () => {
    vi.stubGlobal("navigator", {});
    const { clipboard } = stubCopyCommand({ fires: true, copies: true });
    const pageListener = vi.fn<(event: Event) => void>();
    document.addEventListener("copy", pageListener);

    await copyText("mine");

    document.removeEventListener("copy", pageListener);
    expect(pageListener).not.toHaveBeenCalled();
    expect(clipboard.get("text/plain")).toBe("mine");
  });

  it.each([
    ["the browser refuses the command", { fires: true, copies: false }],
    ["the command never reaches the page's copy event", { fires: false, copies: true }],
    ["the command throws", { fires: false, copies: false, throws: true }],
  ])("reports failure when %s", async (_case, command) => {
    vi.stubGlobal("navigator", {});
    stubCopyCommand(command);

    await expect(copyText("x")).resolves.toBe(false);
  });

  it.each([
    ["the copy happened", { fires: true, copies: true }],
    ["the browser refused", { fires: true, copies: false }],
    ["no copy event came", { fires: false, copies: true }],
    ["the command threw", { fires: false, copies: false, throws: true }],
  ])("leaves no listener behind when %s", async (_case, command) => {
    vi.stubGlobal("navigator", {});
    stubCopyCommand(command);
    await copyText("mine");

    // A later copy by the user must reach the page as it is, with its own data.
    const later = new Event("copy", { cancelable: true }) as ClipboardEvent;
    const setData = vi.fn<(type: string, text: string) => void>();
    Object.defineProperty(later, "clipboardData", { value: { setData } });
    document.dispatchEvent(later);

    expect(setData).not.toHaveBeenCalled();
    expect(later.defaultPrevented).toBe(false);
  });
});
