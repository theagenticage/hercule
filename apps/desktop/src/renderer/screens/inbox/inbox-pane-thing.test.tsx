/** Tests the pane's content for one thing: its meta line, the Task it is on, the blocks' states, links and history. */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { InboxPaneThing } from "./inbox-pane-thing";
import { TEST_PLUGINS } from "./inbox-row.testing";

const renderThing = (props: Partial<Parameters<typeof InboxPaneThing>[0]> = {}) => {
  const onViewTask = vi.fn();
  const onGoTo = vi.fn();
  render(
    <InboxPaneThing
      title="Fix the checkout total"
      identifier="#482"
      meta={[{ kind: "words", words: "Mei opened it 2d ago" }]}
      asks={null}
      blocks={{ state: "ready", content: null }}
      links={[]}
      history={[]}
      plugins={TEST_PLUGINS}
      onViewTask={onViewTask}
      onGoTo={onGoTo}
      {...props}
    />,
  );
  return { onViewTask, onGoTo };
};

describe("InboxPaneThing", () => {
  it("draws the title with its identifier after it", () => {
    renderThing();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
      "Fix the checkout total #482",
    );
  });

  it("draws each meta item as its own item, none starting with a separator", () => {
    renderThing({
      meta: [
        { kind: "words", words: "Mei opened it 2d ago" },
        { kind: "words", words: "in northwind" },
        { kind: "words", words: "Dismissed 3d ago, back for a review" },
      ],
    });
    const items = [...document.querySelectorAll(".ib-pane-meta > span")];
    expect(items.map((item) => item.textContent)).toEqual([
      "Mei opened it 2d ago",
      "in northwind",
      "Dismissed 3d ago, back for a review",
    ]);
    expect(document.querySelector(".ib-pane-meta")?.textContent ?? "").not.toContain("·");
  });

  it("shows the Task the thing is on, with what runs on it, and views it", async () => {
    const { onViewTask } = renderThing({
      task: {
        title: "Review the checkout fix",
        activity: "Review PR running",
        faceSeed: "review-pr",
      },
    });
    expect(screen.getByText("Review the checkout fix")).toBeTruthy();
    expect(screen.getByText("Review PR running")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /View task/ }));
    expect(onViewTask).toHaveBeenCalledOnce();
  });

  it("shows a Task nothing runs on", () => {
    renderThing({
      task: { title: "Install with Bun", activity: "Nothing running" },
    });
    expect(screen.getByText("Nothing running")).toBeTruthy();
    expect(screen.getByRole("button", { name: /View task/ })).toBeTruthy();
  });

  it("draws no Task strip for a thing on no Task", () => {
    renderThing();
    expect(screen.queryByRole("button", { name: /View task/ })).toBeNull();
  });

  it("draws the asks before the blocks", () => {
    renderThing({
      asks: <p>An ask</p>,
      blocks: { state: "ready", content: <p>A block</p> },
    });
    const ask = screen.getByText("An ask");
    const block = screen.getByText("A block");
    expect(ask.compareDocumentPosition(block) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says in one line that the blocks could not be read", () => {
    renderThing({ blocks: { state: "failed", words: "GitHub couldn't be read just now." } });
    expect(screen.getByText("GitHub couldn't be read just now.")).toBeTruthy();
  });

  it("draws nothing for blocks that are ready and empty", () => {
    renderThing();
    expect(document.querySelector(".ib-pane-blocks")).toBeNull();
  });

  it("draws who claims each link and walks to a linked thing by its title", async () => {
    const { onGoTo } = renderThing({
      links: [
        {
          ref: "linear:ENG-9",
          pluginId: "linear",
          title: "Checkout total is off",
          identifier: "ENG-9",
          claim: "Linear reports this",
        },
        { ref: "github:#7", pluginId: "github", title: "Older fix", claim: "You linked this" },
      ],
    });
    expect(screen.getByText("Linear reports this")).toBeTruthy();
    expect(screen.getByText("You linked this")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Unlink/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Checkout total is off" }));
    expect(onGoTo).toHaveBeenCalledWith("linear:ENG-9");
  });

  it("lists what happened in the order it is given, time first", () => {
    renderThing({
      history: [
        { when: "1h", sentence: "Mei asked for your review" },
        { when: "2d", sentence: "Opened by Mei" },
      ],
    });
    const rows = within(screen.getByRole("heading", { name: "What happened" }).parentElement!)
      .getAllByRole("listitem")
      .map((row) => row.textContent);
    expect(rows).toEqual(["1hMei asked for your review", "2dOpened by Mei"]);
  });
});
