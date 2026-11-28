/**
 * Tests the project pick of the start-thread dialog: its three looks, and the
 * menu that lists the projects and "No project". jsdom hides a popover until
 * it matches `:popover-open`, which its stub never sets, so the menu's queries
 * pass `hidden: true`.
 */
import { createRef } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  ProjectPick,
  type ProjectPickOption,
  type ProjectPickValue,
} from "./thread-dialog-project-pick";

const PROJECTS: readonly ProjectPickOption[] = [
  { id: "p1", name: "webshop", tint: "webshop", repositories: "storefront-web, platform-core" },
  { id: "p2", name: "payments-api", tint: "payments", repositories: "payments-api" },
];

const renderPick = (pick: ProjectPickValue, onPick = vi.fn()) => {
  render(
    <ProjectPick
      pick={pick}
      reason="Chosen because #6244 is in storefront-web."
      projects={PROJECTS}
      onPick={onPick}
    />,
  );
  return { onPick };
};

const getMenu = (): HTMLElement => screen.getByRole("menu", { hidden: true });

describe("ProjectPick", () => {
  it("shows the picked project's name", () => {
    renderPick({ kind: "project", projectId: "p1" });

    expect(screen.getByRole("button", { name: "Project webshop" })).toBeTruthy();
  });

  it("shows No project with its note when the user chose no code", () => {
    renderPick({ kind: "none" });

    expect(screen.getByRole("button", { name: "No project" })).toBeTruthy();
    expect(screen.getByText("No checkout")).toBeTruthy();
  });

  it("asks for a choice in the colour of what asks, when nothing is picked", () => {
    renderPick({ kind: "unpicked" });

    const pick = screen.getByRole("button", { name: "Choose a project" });
    expect(pick.classList.contains("lip-pick--ask")).toBe(true);
  });

  it("lists the reason, each project with its repositories, a check on the current one, and No project", () => {
    renderPick({ kind: "project", projectId: "p1" });

    expect(screen.getByText("Chosen because #6244 is in storefront-web.")).toBeTruthy();
    const items = within(getMenu()).getAllByRole("menuitemradio", { hidden: true });
    expect(items.map((item) => item.textContent)).toEqual([
      "webshopstorefront-web, platform-core",
      "payments-apipayments-api",
      "No project: no code, no checkout",
    ]);
    expect(items.map((item) => item.getAttribute("aria-checked"))).toEqual([
      "true",
      "false",
      "false",
    ]);
  });

  it("calls back with the project's id when a project is picked", async () => {
    const { onPick } = renderPick({ kind: "unpicked" });

    await userEvent.click(
      within(getMenu()).getByRole("menuitemradio", { name: /payments-api/, hidden: true }),
    );

    expect(onPick).toHaveBeenCalledExactlyOnceWith("p2");
  });

  it("calls back with null when No project is picked", async () => {
    const { onPick } = renderPick({ kind: "project", projectId: "p1" });

    await userEvent.click(
      within(getMenu()).getByRole("menuitemradio", { name: /No project/, hidden: true }),
    );

    expect(onPick).toHaveBeenCalledExactlyOnceWith(null);
  });

  it("opens its menu from the function it hands out", () => {
    const openMenuRef = createRef<() => void>();
    const showPopover = vi.fn();
    render(
      <ProjectPick
        pick={{ kind: "unpicked" }}
        reason="Nothing here points at a repository."
        projects={PROJECTS}
        openMenuRef={openMenuRef}
        onPick={vi.fn()}
      />,
    );
    const pick = screen.getByRole("button", { name: "Choose a project" });
    pick.addEventListener("click", showPopover);

    openMenuRef.current?.();

    expect(showPopover).toHaveBeenCalledOnce();
  });
});
