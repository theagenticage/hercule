/**
 * Tests the start-thread dialog: what each of its two states draws, the
 * starters, the keys that start the thread and open it, the thing chips, and
 * that the dialog reports its close once.
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesktopPlatform } from "../../../ipc/platform/desktop-platform";
import { HERCULE_LOOK } from "../../faces";
import { ThingChips, type ThingChip } from "./thread-dialog-chips";
import { ThreadDialog, type StartedPhase, type WritingPhase } from "./thread-dialog";

const THINGS: readonly ThingChip[] = [
  {
    id: "a",
    pluginId: "linear",
    identifier: "SHOP-142",
    title: "Show the delivery cost before the payment step",
  },
  {
    id: "b",
    pluginId: "github",
    identifier: "#6244",
    title: "Show the delivery cost on the payment step",
  },
];

const STARTERS = [
  { starter: "investigate", label: "Investigate" },
  { starter: "fix", label: "Fix" },
  { starter: "own", label: "Your own words" },
] as const;

const buildWriting = (overrides: Partial<WritingPhase> = {}): WritingPhase => ({
  kind: "writing",
  title: "Show the delivery cost",
  starters: STARTERS,
  chosenStarter: "investigate",
  composer: <textarea aria-label="Message" />,
  reason: [{ text: "webshop", strong: true }, { text: " because #6244 is in storefront-web." }],
  onTitleChange: vi.fn(),
  onPickStarter: vi.fn(),
  onStart: vi.fn(),
  ...overrides,
});

const buildStarted = (overrides: Partial<StartedPhase> = {}): StartedPhase => ({
  kind: "started",
  title: "Show the delivery cost",
  summary: "Thread started · webshop · Opus 5.5 · High",
  transcript: <p>Look into these 4</p>,
  note: "All 4 are on this Task now",
  onOpenThread: vi.fn(),
  ...overrides,
});

const renderDialog = (
  phase: WritingPhase | StartedPhase,
  {
    onClose = vi.fn(),
    platform = "linux",
  }: { onClose?: () => void; platform?: DesktopPlatform } = {},
) => {
  const view = render(
    <ThreadDialog phase={phase} look={HERCULE_LOOK} platform={platform} onClose={onClose} />,
  );
  return { ...view, onClose };
};

describe("ThreadDialog while writing", () => {
  it("draws the editable name, the sub-line, the starters, the composer and the reason", () => {
    renderDialog(buildWriting());

    const dialog = screen.getByRole("dialog", { name: "Start a thread" });
    expect(within(dialog).getByLabelText<HTMLInputElement>("The Task’s name").value).toBe(
      "Show the delivery cost",
    );
    expect(within(dialog).getByText("A new Task on Work, with a thread on it")).toBeTruthy();
    expect(within(dialog).getByLabelText("Message")).toBeTruthy();
    const reason = within(dialog).getByText("webshop");
    expect(reason.tagName).toBe("B");
    expect(reason.parentElement?.textContent).toBe("webshop because #6244 is in storefront-web.");
  });

  it("marks the chosen starter and calls back with the starter that is picked", async () => {
    const onPickStarter = vi.fn();
    renderDialog(buildWriting({ onPickStarter }));

    const group = screen.getByRole("radiogroup", { name: "Start from" });
    expect(
      within(group)
        .getAllByRole("radio")
        .map((radio) => [radio.textContent, radio.getAttribute("aria-checked")]),
    ).toEqual([
      ["Investigate", "true"],
      ["Fix", "false"],
      ["Your own words", "false"],
    ]);
    await userEvent.click(within(group).getByRole("radio", { name: "Fix" }));

    expect(onPickStarter).toHaveBeenCalledExactlyOnceWith("fix");
  });

  it("moves the focus between the starters with the arrow keys without picking one", async () => {
    const onPickStarter = vi.fn();
    renderDialog(buildWriting({ onPickStarter }));

    screen.getByRole("radio", { name: "Investigate" }).focus();
    await userEvent.keyboard("{ArrowRight}");

    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Fix" }));
    expect(onPickStarter).not.toHaveBeenCalled();
  });

  it("reports each edit of the name", async () => {
    const onTitleChange = vi.fn();
    renderDialog(buildWriting({ onTitleChange }));

    await userEvent.type(screen.getByLabelText("The Task’s name"), "!");

    expect(onTitleChange).toHaveBeenCalledWith("Show the delivery cost!");
  });

  it("starts on Ctrl+Enter off macOS, and on ⌘+Enter on a Mac, never on the other one", async () => {
    const onStart = vi.fn();
    const linux = renderDialog(buildWriting({ onStart }));
    screen.getByLabelText("Message").focus();

    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onStart).not.toHaveBeenCalled();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(onStart).toHaveBeenCalledOnce();
    linux.unmount();

    onStart.mockClear();
    renderDialog(buildWriting({ onStart }), { platform: "mac" });
    screen.getByLabelText("Message").focus();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(onStart).not.toHaveBeenCalled();
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    expect(onStart).toHaveBeenCalledOnce();
  });

  it("starts from the name's input, and leaves a ⌘↩ the field already handled to the field", async () => {
    const onStart = vi.fn();
    renderDialog(buildWriting({ onStart }));

    await userEvent.type(screen.getByLabelText("The Task’s name"), "{Control>}{Enter}{/Control}");
    expect(onStart).toHaveBeenCalledOnce();

    onStart.mockClear();
    const field = screen.getByLabelText("Message");
    field.addEventListener("keydown", (event) => {
      event.preventDefault();
    });
    field.focus();
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    expect(onStart).not.toHaveBeenCalled();
  });

  it("closes from the close button, once, and reports it", async () => {
    const { onClose } = renderDialog(buildWriting());

    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("takes over Esc, so the close plays its motion, and reports the close once", () => {
    const { onClose } = renderDialog(buildWriting());
    const dialog = screen.getByRole("dialog", { name: "Start a thread" });

    const cancel = new Event("cancel", { cancelable: true });
    fireEvent(dialog, cancel);
    fireEvent(dialog, new Event("cancel", { cancelable: true }));

    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("ThreadDialog once started", () => {
  it("draws the fixed name, the summary, the transcript and the footer", () => {
    renderDialog(buildStarted());

    const dialog = screen.getByRole("dialog", { name: "Thread started" });
    expect(within(dialog).queryByLabelText("The Task’s name")).toBeNull();
    expect(within(dialog).getByText("Show the delivery cost")).toBeTruthy();
    expect(within(dialog).getByText("Thread started · webshop · Opus 5.5 · High")).toBeTruthy();
    expect(within(dialog).getByText("Look into these 4")).toBeTruthy();
    expect(within(dialog).getByText("All 4 are on this Task now")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Back to the Inbox" })).toBeTruthy();
  });

  it("gives the focus to Open the thread when the thread starts", () => {
    const { rerender } = renderDialog(buildWriting());
    expect(document.activeElement).not.toBe(
      screen.queryByRole("button", { name: /Open the thread/ }),
    );

    rerender(
      <ThreadDialog
        phase={buildStarted()}
        look={HERCULE_LOOK}
        platform="linux"
        onClose={vi.fn()}
      />,
    );

    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open the thread" }));
  });

  it("opens the thread on Enter, but leaves Enter on another button to that button", async () => {
    const onOpenThread = vi.fn();
    const { onClose } = renderDialog(buildStarted({ onOpenThread }));

    await userEvent.keyboard("{Enter}");
    expect(onOpenThread).toHaveBeenCalledOnce();

    onOpenThread.mockClear();
    screen.getByRole("button", { name: "Back to the Inbox" }).focus();
    await userEvent.keyboard("{Enter}");
    expect(onOpenThread).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("ThingChips", () => {
  it("draws the identifier and the title of each thing, with a button to leave it out", async () => {
    const onRemove = vi.fn();
    render(<ThingChips things={THINGS} plugins={[]} onRemove={onRemove} />);

    expect(screen.getByText("SHOP-142")).toBeTruthy();
    expect(screen.getByText("Show the delivery cost on the payment step")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Leave #6244 out" }));

    expect(onRemove).toHaveBeenCalledExactlyOnceWith("b");
  });

  it("names a chip with no identifier by its title", () => {
    render(
      <ThingChips
        things={[
          THINGS[0]!,
          { id: "c", pluginId: "slack", identifier: null, title: "Is it going out Thursday?" },
        ]}
        plugins={[]}
        onRemove={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: "Leave Is it going out Thursday? out" }),
    ).toBeTruthy();
  });

  it("draws no button on the last chip", () => {
    render(<ThingChips things={[THINGS[0]!]} plugins={[]} onRemove={vi.fn()} />);

    expect(screen.queryByRole("button")).toBeNull();
  });
});
