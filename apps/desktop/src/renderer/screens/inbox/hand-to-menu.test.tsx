/** Tests the menu of workflows a card can be handed to: its rows, its keys, and the account it acts as. */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { partitionOffers } from "@hercule/client-core/inbox";
import { buildWorkflowOffer } from "@hercule/client-core/inbox/testing";
import type { ActingConnection } from "@hercule/contract";
import { HandToMenu } from "./hand-to-menu";

const review = buildWorkflowOffer("Agent review", ["github/review-requested"]);
const repair = buildWorkflowOffer("Repair the build", ["github/checks-failed"]);
const draft = buildWorkflowOffer("Draft a change", ["github/review-requested"]);
const shipIt = buildWorkflowOffer("Ship it", [], {
  reason: "repository",
  message: "Ship it works on acme/web only",
});
const BOT: ActingConnection = { id: "conn-bot", label: "northwind-bot" };
const AVA: ActingConnection = { id: "conn-ava", label: "ava-northwind" };

/** Renders the menu over a card, and returns what it called. */
const renderMenu = (
  options: {
    readonly offers?: ReturnType<typeof partitionOffers>;
    readonly accounts?: readonly ActingConnection[];
  } = {},
) => {
  const onHand = vi.fn<(workflowId: string, connectionId: string | undefined) => void>();
  const onClose = vi.fn<() => void>();
  const outside = document.createElement("div");
  outside.setAttribute("data-card-id", "card-1");
  document.body.append(outside);
  render(
    <HandToMenu
      offers={options.offers ?? partitionOffers([review, repair, draft, shipIt])}
      openKinds={["github/review-requested", "github/mention"]}
      actingConnections={options.accounts ?? [BOT]}
      onHand={onHand}
      onClose={onClose}
      anchor={outside}
    />,
  );
  return { onHand, onClose };
};

describe("HandToMenu", () => {
  afterEach(() => {
    document.querySelector("[data-card-id]")?.remove();
  });

  it("lists the available workflows with their line and number, then the others with why", () => {
    renderMenu();

    const items = screen.getAllByRole("menuitem", { hidden: true });
    expect(items.map((item) => within(item).getByText(/./, { selector: "b" }).textContent)).toEqual(
      ["Agent review", "Repair the build", "Draft a change", "Ship it"],
    );
    expect(within(items[0]!).getByText("Ends Review requested. Mention stays open.")).toBeTruthy();
    expect(items.slice(0, 3).map((item) => item.querySelector("kbd")?.textContent)).toEqual([
      "1",
      "2",
      "3",
    ]);
    const last = items[3]!;
    expect(last.getAttribute("aria-disabled")).toBe("true");
    expect(last.querySelector("kbd")).toBeNull();
    expect(within(last).getByText("Ship it works on acme/web only")).toBeTruthy();
  });

  it("hands to the workflow whose number is pressed, and to the active one on Return", async () => {
    const { onHand } = renderMenu();
    const user = userEvent.setup();

    await user.keyboard("2");
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    await user.keyboard("{ArrowUp}{ArrowDown}{ArrowDown}{Enter}");

    expect(onHand.mock.calls.map(([id]) => id)).toEqual([
      repair.workflowId,
      draft.workflowId,
      review.workflowId,
    ]);
  });

  it("hands to the workflow that is clicked", async () => {
    const { onHand } = renderMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: /Repair the build/, hidden: true }));

    expect(onHand).toHaveBeenCalledExactlyOnceWith(repair.workflowId, undefined);
  });

  it("closes on Esc, and no key reaches the page behind it", async () => {
    const { onHand, onClose } = renderMenu({ offers: partitionOffers([review, repair]) });
    const reachedPage = vi.fn();
    window.addEventListener("keydown", reachedPage);
    const user = userEvent.setup();

    await user.keyboard("3");
    await user.keyboard("t");
    await user.keyboard("{Escape}");

    window.removeEventListener("keydown", reachedPage);
    expect(onHand).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    expect(reachedPage).not.toHaveBeenCalled();
  });

  it("names the account it acts as when there are several, and hands as the one the user picks", async () => {
    const { onHand } = renderMenu({ accounts: [BOT, AVA] });

    const account = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Account to act as",
      hidden: true,
    });
    expect(account.selectedOptions[0]?.textContent).toBe("northwind-bot");
    await userEvent.selectOptions(account, "conn-ava");
    await userEvent.click(screen.getByRole("menuitem", { name: /Repair the build/, hidden: true }));

    expect(onHand).toHaveBeenCalledExactlyOnceWith(repair.workflowId, "conn-ava");
  });

  it("hands with no account when the user picked none, so the controller chooses", async () => {
    const { onHand } = renderMenu({ accounts: [BOT, AVA] });

    await userEvent.click(screen.getByRole("menuitem", { name: /Agent review/, hidden: true }));

    expect(onHand).toHaveBeenCalledExactlyOnceWith(review.workflowId, undefined);
  });

  it("keeps the account the user picked when a push says it can no longer act, and says so", async () => {
    const onHand = vi.fn<(workflowId: string, connectionId: string | undefined) => void>();
    const anchor = document.createElement("div");
    anchor.setAttribute("data-card-id", "card-1");
    document.body.append(anchor);
    const menu = (accounts: readonly ActingConnection[]) => (
      <HandToMenu
        offers={partitionOffers([review])}
        openKinds={[]}
        actingConnections={accounts}
        onHand={onHand}
        onClose={vi.fn()}
        anchor={anchor}
      />
    );
    const { rerender } = render(menu([BOT, AVA]));
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Account to act as", hidden: true }),
      "conn-ava",
    );

    rerender(menu([BOT]));

    const account = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Account to act as",
      hidden: true,
    });
    expect(account.selectedOptions[0]?.textContent).toBe("This account can no longer act");
    await userEvent.click(screen.getByRole("menuitem", { name: /Agent review/, hidden: true }));
    expect(onHand).toHaveBeenCalledExactlyOnceWith(review.workflowId, "conn-ava");
  });

  it("names no account when there is only one", () => {
    renderMenu({ accounts: [BOT] });

    expect(screen.queryByRole("combobox", { hidden: true })).toBeNull();
  });
});
