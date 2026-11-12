/** Tests the menu of workflows a thing can be handed to: its ranking, its keys, its find field, and the account it acts as. */
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { partitionOffers } from "@hercule/client-core/inbox";
import { buildInboxAsk, buildWorkflowOffer } from "@hercule/client-core/inbox/testing";
import type { ActingConnection } from "@hercule/contract";
import { HandToMenu } from "./hand-to-menu";

/** A thing Mei asked a review of and Omar mentioned: `askKinds` and `openKinds` are what the controller lists. */
const THING = {
  asks: [
    buildInboxAsk("a1", "Mei", { kind: "github/review-requested" }),
    buildInboxAsk("a2", "Omar", { kind: "github/mention", noun: "mention" }),
  ],
  askCount: 2,
  askKinds: ["github/review-requested", "github/mention"],
  openKinds: ["github/review-requested", "github/mention"],
};

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
    readonly chosenConnectionId?: string;
  } = {},
) => {
  const onHand = vi.fn<(workflowId: string) => void>();
  const onChooseConnection = vi.fn<(connectionId: string) => void>();
  const onClose = vi.fn<() => void>();
  const outside = document.createElement("div");
  outside.setAttribute("data-card-id", "card-1");
  document.body.append(outside);
  render(
    <HandToMenu
      offers={options.offers ?? partitionOffers([review, repair, draft, shipIt])}
      thing={THING}
      actingConnections={options.accounts ?? [BOT]}
      chosenConnectionId={options.chosenConnectionId}
      onChooseConnection={onChooseConnection}
      onHand={onHand}
      onClose={onClose}
      anchor={outside}
    />,
  );
  return { onHand, onChooseConnection, onClose };
};

describe("HandToMenu", () => {
  afterEach(() => {
    document.querySelector("[data-card-id]")?.remove();
  });

  it("ranks the workflows by fit, names the asks each ends and leaves, then lists the others with why", () => {
    renderMenu();

    const items = screen.getAllByRole("menuitem", { hidden: true });
    // Agent review and Draft a change end Mei's ask and leave Omar's: they fit better than Repair, which ends none.
    expect(items.map((item) => within(item).getByText(/./, { selector: "b" }).textContent)).toEqual(
      ["Agent review", "Draft a change", "Repair the build", "Ship it"],
    );
    expect(
      within(items[0]!).getByText("Ends Mei’s review request. Leaves Omar’s mention with you."),
    ).toBeTruthy();
    expect(
      within(items[2]!).getByText(
        "Ends none of its asks. Leaves Mei’s review request and Omar’s mention with you.",
      ),
    ).toBeTruthy();
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

    // Ranked: Agent review, Draft a change, Repair the build.
    expect(onHand.mock.calls.map(([id]) => id)).toEqual([
      draft.workflowId,
      repair.workflowId,
      review.workflowId,
    ]);
  });

  it("hands to the workflow that is clicked", async () => {
    const { onHand } = renderMenu();

    await userEvent.click(screen.getByRole("menuitem", { name: /Repair the build/, hidden: true }));

    expect(onHand).toHaveBeenCalledExactlyOnceWith(repair.workflowId);
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

  it("names the first account when the user picked none, and reports the account the user picks", async () => {
    const { onChooseConnection } = renderMenu({ accounts: [BOT, AVA] });

    const account = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Account to act as",
      hidden: true,
    });
    expect(account.selectedOptions[0]?.textContent).toBe("northwind-bot");
    await userEvent.selectOptions(account, "conn-ava");

    expect(onChooseConnection).toHaveBeenCalledExactlyOnceWith("conn-ava");
  });

  it("shows the account the parent says the user picked", () => {
    renderMenu({ accounts: [BOT, AVA], chosenConnectionId: "conn-ava" });

    const account = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Account to act as",
      hidden: true,
    });
    expect(account.selectedOptions[0]?.textContent).toBe("ava-northwind");
  });

  it("keeps the account the user picked when a push says it can no longer act, and says so", () => {
    renderMenu({ accounts: [BOT], chosenConnectionId: "conn-ava" });

    const account = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Account to act as",
      hidden: true,
    });
    expect(account.selectedOptions[0]?.textContent).toBe("This account can no longer act");
  });

  it("names no account when there is only one", () => {
    renderMenu({ accounts: [BOT] });

    expect(screen.queryByRole("combobox", { hidden: true })).toBeNull();
  });

  it("opens under the element it is given, its right edge level with that element's", () => {
    const row = document.createElement("div");
    const card = document.createElement("div");
    card.setAttribute("data-card-id", "card-1");
    card.getBoundingClientRect = () => new DOMRect(0, 900, 100, 50);
    card.append(row);
    document.body.append(card);
    row.getBoundingClientRect = () => new DOMRect(100, 40, 400, 52);
    render(
      <HandToMenu
        offers={partitionOffers([review])}
        thing={THING}
        actingConnections={[BOT]}
        chosenConnectionId={undefined}
        onChooseConnection={vi.fn()}
        onHand={vi.fn()}
        onClose={vi.fn()}
        anchor={row}
      />,
    );

    const menu = document.querySelector<HTMLElement>(".hand-menu")!;
    // jsdom lays nothing out, so the menu is 0 wide: its right edge is the row's, at 500.
    expect(menu.style.left).toBe("500px");
    expect(menu.style.top).toBe("98px");
    card.remove();
  });

  describe("with many workflows", () => {
    // Ranked: the three that end one of the two asks first (by name), then the three that end none.
    const many = [
      buildWorkflowOffer("Review PR", ["github/review-requested"]),
      buildWorkflowOffer("Answer a code question", ["github/mention"]),
      buildWorkflowOffer("Security review", ["github/review-requested"]),
      ...["Fix a failing check", "Split the pull request", "Write the release note"].map((name) =>
        buildWorkflowOffer(name, []),
      ),
    ];

    it("has no find field below six workflows", () => {
      renderMenu({ offers: partitionOffers(many.slice(0, 5)) });

      expect(screen.queryByRole("combobox", { name: "Hand to", hidden: true })).toBeNull();
    });

    it("has a find field with the focus, and 1 to 3 still pick while nothing is typed", async () => {
      const { onHand } = renderMenu({ offers: partitionOffers(many) });
      const field = screen.getByRole("combobox", { name: "Hand to", hidden: true });

      expect(document.activeElement).toBe(field);
      await userEvent.keyboard("2");

      expect(onHand).toHaveBeenCalledExactlyOnceWith(many[0]!.workflowId);
    });

    it("finds by name or by what a workflow does, and picks from what is found", async () => {
      const { onHand } = renderMenu({ offers: partitionOffers(many) });
      const user = userEvent.setup();

      await user.type(screen.getByRole("combobox", { name: "Hand to", hidden: true }), "rev");
      expect(
        screen
          .getAllByRole("option", { hidden: true })
          .map((option) => option.querySelector("b")?.textContent),
      ).toEqual(["Review PR", "Security review"]);

      await user.keyboard("{ArrowDown}{Enter}");
      expect(onHand).toHaveBeenLastCalledWith(many[2]!.workflowId);

      await user.clear(screen.getByRole("combobox", { name: "Hand to", hidden: true }));
      await user.type(screen.getByRole("combobox", { name: "Hand to", hidden: true }), "ends omar");
      expect(
        screen
          .getAllByRole("option", { hidden: true })
          .map((option) => option.querySelector("b")?.textContent),
      ).toEqual(["Answer a code question"]);
    });

    it("lets digits type once something is typed, and says when nothing matches", async () => {
      const { onHand } = renderMenu({ offers: partitionOffers(many) });
      const user = userEvent.setup();
      const field = screen.getByRole<HTMLInputElement>("combobox", {
        name: "Hand to",
        hidden: true,
      });

      await user.type(field, "x2");
      expect(field.value).toBe("x2");
      expect(screen.getByText("No workflow by that name. Esc closes.")).toBeTruthy();
      expect(onHand).not.toHaveBeenCalled();
    });

    it("keeps a workflow that cannot take the thing in the find, dimmed, with its reason", async () => {
      renderMenu({ offers: partitionOffers([...many, shipIt]) });

      await userEvent.type(screen.getByRole("combobox", { name: "Hand to", hidden: true }), "ship");

      const [only] = screen.getAllByRole("option", { hidden: true });
      expect(only?.getAttribute("aria-disabled")).toBe("true");
      expect(within(only!).getByText("Ship it works on acme/web only")).toBeTruthy();
    });
  });
});
