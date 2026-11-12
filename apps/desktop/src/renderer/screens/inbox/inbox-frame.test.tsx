/**
 * Tests the Inbox's frame through its props: which layout the frame's measured width gives, how the
 * pane's width is limited and changed, the pane lying over the list, and the pane stepping aside.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps, JSX } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InboxFrame } from "./inbox-frame";

/** The callbacks of the observer the frame made, so a test can say how wide the frame is. */
let reportWidth: (width: number) => void = () => undefined;

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        reportWidth = (width) => {
          act(() => {
            callback([{ contentRect: { width } } as ResizeObserverEntry], this);
          });
        };
      }
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty("--dur-2");
});

/** Renders a frame with filled slots; `props` replace the defaults. */
function renderFrame(props: Partial<ComponentProps<typeof InboxFrame>> = {}): {
  readonly frame: HTMLElement;
} {
  const element: JSX.Element = (
    <InboxFrame
      rail={
        <>
          <button type="button" tabIndex={-1}>
            Mine
          </button>
          <button type="button" tabIndex={-1} aria-current="true">
            Someone waits on me
          </button>
        </>
      }
      scopeName="Someone waits on me"
      search={<input aria-label="Search the Inbox" />}
      list={<p>The rows</p>}
      paneHead={<span>From GitHub</span>}
      pane={<p>The open thing</p>}
      offlinePill={null}
      isPaneShown
      isPaneOpen={false}
      paneWidth={420}
      onPaneWidthChange={vi.fn()}
      onClosePane={vi.fn()}
      onOpenIntake={vi.fn()}
      onOpenKeys={vi.fn()}
      isKeysOpen={false}
      {...props}
    />
  );
  const { container } = render(element);
  return { frame: container.firstElementChild as HTMLElement };
}

describe("InboxFrame layout", () => {
  it("keeps the rail beside the list while the frame is wide", () => {
    renderFrame();
    reportWidth(1400);

    expect(document.getElementById("inbox-rail")?.textContent).toContain("Mine");
    expect(document.getElementById("inbox-scope-button")).toBeNull();
  });

  it("folds the rail into the scope button's menu under 1058px, with the same rail in it", () => {
    renderFrame();
    reportWidth(1057);

    const scopeButton = document.getElementById("inbox-scope-button");
    expect(scopeButton?.textContent).toBe("Someone waits on me");
    expect(document.getElementById("inbox-rail")).toBeNull();
    const menu = document.getElementById("inbox-scope-menu");
    expect(menu?.textContent).toContain("Mine");
  });

  it("opens the scope menu with the focus on the current entry", () => {
    renderFrame();
    reportWidth(900);
    const menu = document.getElementById("inbox-scope-menu")!;

    fireEvent(menu, Object.assign(new Event("toggle"), { newState: "open" }));

    expect(document.activeElement?.textContent).toBe("Someone waits on me");
  });

  it("drops the pill under 628px and keeps it from there up", () => {
    renderFrame();
    reportWidth(628);
    expect(screen.getByRole("button", { name: "Intake" }).closest(".ib-pill")).not.toBeNull();
    expect(document.querySelector(".ib")?.classList.contains("is-pill-gone")).toBe(false);

    reportWidth(627);
    expect(document.querySelector(".ib")?.classList.contains("is-pill-gone")).toBe(true);
  });

  it("calls onOpenIntake when the pill's Intake tab is pressed", async () => {
    const onOpenIntake = vi.fn();
    renderFrame({ onOpenIntake });

    await userEvent.click(screen.getByRole("button", { name: "Intake" }));

    expect(onOpenIntake).toHaveBeenCalledOnce();
  });

  it("calls onOpenKeys from the keys button and shows it expanded while the keys are open", async () => {
    const onOpenKeys = vi.fn();
    renderFrame({ onOpenKeys, isKeysOpen: true });
    const keys = screen.getByRole("button", { name: "Show the keys" });

    await userEvent.click(keys);

    expect(onOpenKeys).toHaveBeenCalledOnce();
    expect(keys.getAttribute("aria-expanded")).toBe("true");
  });
});

describe("InboxFrame pane width", () => {
  it("shows the width asked for, between 360 and 640", () => {
    const { frame } = renderFrame({ paneWidth: 500 });
    reportWidth(2000);
    expect(frame.style.getPropertyValue("--pane-w")).toBe("500px");
  });

  it("never shows a pane wider than 640 or narrower than 360", () => {
    const { frame } = renderFrame({ paneWidth: 900 });
    reportWidth(2000);
    expect(frame.style.getPropertyValue("--pane-w")).toBe("640px");
  });

  it("never gives the pane so much that the list keeps less than 400px", () => {
    const { frame } = renderFrame({ paneWidth: 640 });

    // Rail 240 + list 400 leaves 1200 - 640 = 560 for the pane.
    reportWidth(1200);
    expect(frame.style.getPropertyValue("--pane-w")).toBe("560px");
    // The rail is folded here, so only the list's 400px comes off.
    reportWidth(1000);
    expect(frame.style.getPropertyValue("--pane-w")).toBe("600px");
    // Between 760 and 800 the list cannot keep 400px beside even the narrowest pane, which stays 360.
    reportWidth(760);
    expect(frame.style.getPropertyValue("--pane-w")).toBe("360px");
  });

  it("grows the pane back to the width asked for when the window grows again", () => {
    const { frame } = renderFrame({ paneWidth: 560 });
    reportWidth(1100);
    expect(frame.style.getPropertyValue("--pane-w")).toBe("460px");
    reportWidth(900);
    expect(frame.style.getPropertyValue("--pane-w")).toBe("500px");
    reportWidth(1500);
    expect(frame.style.getPropertyValue("--pane-w")).toBe("560px");
  });

  it("reports the width a double click on the edge gives, and the widest and narrowest from Home and End", () => {
    const onPaneWidthChange = vi.fn();
    renderFrame({ paneWidth: 500, onPaneWidthChange });
    reportWidth(1400);
    const edge = screen.getByRole("separator", { name: "Resize the pane" });
    expect(edge.getAttribute("aria-valuemax")).toBe("640");
    expect(edge.getAttribute("aria-valuemin")).toBe("360");

    fireEvent.doubleClick(edge);
    fireEvent.keyDown(edge, { key: "Home" });
    fireEvent.keyDown(edge, { key: "End" });

    expect(onPaneWidthChange.mock.calls).toEqual([[420], [640], [360]]);
  });

  it("limits the widest width to the room the list leaves", () => {
    renderFrame({ paneWidth: 420 });
    reportWidth(1100);

    expect(
      screen.getByRole("separator", { name: "Resize the pane" }).getAttribute("aria-valuemax"),
    ).toBe("460");
    reportWidth(1000);
    expect(
      screen.getByRole("separator", { name: "Resize the pane" }).getAttribute("aria-valuemax"),
    ).toBe("600");
  });
});

describe("InboxFrame pane menu", () => {
  it("sets Narrow, Default and Wide, and shows the one the pane has as checked", async () => {
    const onPaneWidthChange = vi.fn();
    renderFrame({ paneWidth: 420, onPaneWidthChange });
    reportWidth(1600);

    expect(
      screen
        .getByRole("menuitemradio", { name: /Default/, hidden: true })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await userEvent.click(screen.getByRole("menuitemradio", { name: /Wide/, hidden: true }));

    expect(onPaneWidthChange).toHaveBeenCalledExactlyOnceWith(560);
  });

  it("disables a width the window cannot give and does not pick it", async () => {
    const onPaneWidthChange = vi.fn();
    renderFrame({ paneWidth: 420, onPaneWidthChange });
    reportWidth(1100);
    const wide = screen.getByRole("menuitemradio", { name: /Wide/, hidden: true });

    // 1100 less the rail (240) and the list (400) leaves 460: Wide needs 560.
    expect(wide.getAttribute("aria-disabled")).toBe("true");
    expect(wide.getAttribute("title")).toBe("The window is too narrow for it");
    await userEvent.click(wide);
    expect(onPaneWidthChange).not.toHaveBeenCalled();
  });

  it("offers Open at its source only when the caller can open it", async () => {
    const onOpenAtSource = vi.fn();
    const { frame } = renderFrame({ onOpenAtSource });
    expect(frame).toBeTruthy();

    await userEvent.click(
      screen.getByRole("menuitem", { name: /Open at its source/, hidden: true }),
    );

    expect(onOpenAtSource).toHaveBeenCalledOnce();
  });

  it("has no Open at its source without a callback", () => {
    renderFrame();
    expect(screen.queryByRole("menuitem", { name: /Open at its source/, hidden: true })).toBeNull();
  });
});

describe("InboxFrame stacked pane", () => {
  it("has no edge and no widths under 760px, and lies over the list", () => {
    renderFrame({ isPaneOpen: true });
    reportWidth(759);

    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.queryByRole("menuitemradio", { name: /Wide/, hidden: true })).toBeNull();
    expect(document.querySelector(".ib")?.classList.contains("is-pane-open")).toBe(true);
  });

  it("makes the list inert while the pane lies over it, and not otherwise", () => {
    const { frame } = renderFrame({ isPaneOpen: true });
    reportWidth(759);
    const list = frame.querySelector("#inbox-list");
    expect(list?.hasAttribute("inert")).toBe(true);

    reportWidth(1500);
    expect(list?.hasAttribute("inert")).toBe(false);
  });

  it("makes the pane inert while it is slid out", () => {
    const { frame } = renderFrame({ isPaneOpen: false });
    reportWidth(759);
    expect(frame.querySelector("#inbox-pane")?.hasAttribute("inert")).toBe(true);
  });

  it("calls onClosePane for Esc in the pane and for the List button", async () => {
    const onClosePane = vi.fn();
    renderFrame({ isPaneOpen: true, onClosePane });
    reportWidth(759);

    fireEvent.keyDown(screen.getByText("The open thing"), { key: "Escape" });
    await userEvent.click(screen.getByRole("button", { name: "List" }));

    expect(onClosePane).toHaveBeenCalledTimes(2);
  });

  it("leaves Esc to an open menu in the pane", () => {
    const onClosePane = vi.fn();
    renderFrame({ isPaneOpen: true, onClosePane, onOpenAtSource: vi.fn() });
    reportWidth(759);

    fireEvent.keyDown(screen.getByRole("menuitem", { name: /Open at its source/, hidden: true }), {
      key: "Escape",
    });

    expect(onClosePane).not.toHaveBeenCalled();
  });

  it("does not call onClosePane for Esc when the pane is beside the list", () => {
    const onClosePane = vi.fn();
    renderFrame({ onClosePane });
    reportWidth(1500);

    fireEvent.keyDown(screen.getByText("The open thing"), { key: "Escape" });

    expect(onClosePane).not.toHaveBeenCalled();
  });
});

describe("InboxFrame without a current thing", () => {
  it("lets the list take the pane's room at once with reduced motion", () => {
    const { frame } = renderFrame({ isPaneShown: false });
    reportWidth(1500);

    expect(frame.classList.contains("is-paneless")).toBe(true);
  });

  it("keeps the pane, inert and showing what it showed, while it fades, and then lets the list take its room", async () => {
    document.documentElement.style.setProperty("--dur-2", "200ms");
    let finish: () => void = () => undefined;
    const cancel = vi.fn();
    HTMLElement.prototype.animate = vi.fn(
      () =>
        ({
          finished: new Promise<void>((resolve) => {
            finish = resolve;
          }),
          cancel,
        }) as unknown as Animation,
    );
    const element = (isPaneShown: boolean): JSX.Element => (
      <InboxFrame
        rail={null}
        scopeName="Mine"
        search={null}
        list={null}
        paneHead={null}
        pane={isPaneShown ? <p>The open thing</p> : null}
        offlinePill={null}
        isPaneShown={isPaneShown}
        isPaneOpen={false}
        paneWidth={420}
        onPaneWidthChange={vi.fn()}
        onClosePane={vi.fn()}
        onOpenIntake={vi.fn()}
        onOpenKeys={vi.fn()}
        isKeysOpen={false}
      />
    );
    const { container, rerender } = render(element(true));
    const frame = container.firstElementChild as HTMLElement;

    rerender(element(false));
    expect(frame.classList.contains("is-paneless")).toBe(false);
    expect(frame.querySelector("#inbox-pane")?.hasAttribute("inert")).toBe(true);
    expect(screen.getByText("The open thing")).toBeTruthy();

    await act(async () => {
      finish();
      await Promise.resolve();
    });
    expect(frame.classList.contains("is-paneless")).toBe(true);

    rerender(element(true));
    expect(frame.classList.contains("is-paneless")).toBe(false);
    // @ts-expect-error the test installed this stub on the prototype
    delete HTMLElement.prototype.animate;
  });
});
