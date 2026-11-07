/**
 * Tests Add to Work as the user types into it: Return creates the Task, Esc
 * steps back one thing at a time, and the sheet says where the Task lands.
 */
import { useEffect, useRef, type JSX, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AddTaskSheet, type AddTaskLane } from "./add-task-sheet";

const STOREFRONT: AddTaskLane = { id: "storefront", name: "Storefront", projectId: "storefront" };
const NO_PROJECT: AddTaskLane = { id: "no-project", name: "No project", projectId: null };

/** Renders the sheet for `lane`, and returns the title field and what the sheet called. */
const renderSheet = (
  lane: AddTaskLane,
  {
    onCreate = vi.fn().mockResolvedValue(undefined),
    result = null as string | null,
    fromSource = null as ReactNode,
  } = {},
): {
  readonly field: HTMLInputElement;
  readonly onCreate: typeof onCreate;
  readonly onClose: () => void;
} => {
  const onClose = vi.fn();
  render(
    <AddTaskSheet
      lane={lane}
      onCreate={onCreate}
      onClose={onClose}
      result={result}
      fromSource={fromSource}
    />,
  );
  return { field: screen.getByRole("textbox", { name: "New Task" }), onCreate, onClose };
};

describe("AddTaskSheet", () => {
  it("has the title field focused on opening, and says where the Task starts", () => {
    const { field } = renderSheet(STOREFRONT);

    expect(document.activeElement).toBe(field);
    expect(screen.getByText("Starts in Exploring, in Storefront.")).toBeTruthy();
  });

  it("says a Task made in the No project lane has no project", () => {
    renderSheet(NO_PROJECT);

    expect(screen.getByText("Starts in Exploring, with no project.")).toBeTruthy();
  });

  it("creates the Task with the trimmed title on Return, then clears the field", async () => {
    const user = userEvent.setup();
    const { field, onCreate } = renderSheet(STOREFRONT);

    await user.type(field, "  Add a returns page  {Enter}");

    expect(onCreate).toHaveBeenCalledExactlyOnceWith("Add a returns page");
    expect(field.value).toBe("");
  });

  it("creates nothing for a blank title", async () => {
    const user = userEvent.setup();
    const { field, onCreate } = renderSheet(STOREFRONT);

    await user.type(field, "   {Enter}");

    expect(onCreate).not.toHaveBeenCalled();
  });

  it("keeps the title when the Task could not be created, so Return tries again", async () => {
    const user = userEvent.setup();
    const onCreate = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const { field } = renderSheet(STOREFRONT, { onCreate });

    await user.type(field, "Add a returns page{Enter}");
    expect(field.value).toBe("Add a returns page");

    await user.keyboard("{Enter}");
    expect(onCreate).toHaveBeenCalledTimes(2);
    expect(field.value).toBe("");
  });

  it("clears the typed title on the first Esc and closes the sheet on the second", async () => {
    const user = userEvent.setup();
    const { field, onClose } = renderSheet(STOREFRONT);

    await user.type(field, "Add a returns page");
    await user.keyboard("{Escape}");
    expect(field.value).toBe("");
    expect(onClose).not.toHaveBeenCalled();

    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("says where the last Task landed", () => {
    renderSheet(STOREFRONT, { result: "Added to Planned." });

    expect(screen.getByRole("status").textContent).toBe("Added to Planned.");
  });

  it("draws the From a source part under New Task, and leaves the focus to the search it holds", () => {
    /** Stands for From a source: a search field that takes the focus as it mounts. */
    function Source(): JSX.Element {
      const searchRef = useRef<HTMLInputElement>(null);
      useEffect(() => {
        searchRef.current?.focus();
      }, []);
      return <input ref={searchRef} aria-label="Search" />;
    }
    const { field } = renderSheet(STOREFRONT, { fromSource: <Source /> });

    expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Search" }));
    expect(document.activeElement).not.toBe(field);
  });

  it("closes the sheet on Esc in a field of From a source, whatever is typed as the title", async () => {
    const user = userEvent.setup();
    const { field, onClose } = renderSheet(STOREFRONT, {
      fromSource: <input aria-label="Search" />,
    });
    await user.type(field, "Add a returns page");

    await user.click(screen.getByRole("textbox", { name: "Search" }));
    await user.keyboard("{Escape}");

    expect(onClose).toHaveBeenCalledOnce();
    expect(field.value).toBe("Add a returns page");
  });
});
