import { afterEach, describe, expect, it } from "vitest";
import { copyCardForMotion } from "./copy-card-for-motion";

afterEach(() => {
  document.body.replaceChildren();
});

/** Builds a card as the board draws it, in the state of a card being pressed and carried. */
const buildCard = (): HTMLElement => {
  const card = document.createElement("div");
  card.id = "card-1";
  card.className = "desk-card is-focus is-carried";
  card.setAttribute("role", "button");
  card.setAttribute("tabindex", "0");
  card.setAttribute("aria-label", "Refund emails, Exploring");
  card.dataset["cardId"] = "t1";
  card.dataset["stage"] = "exploring";
  card.dataset["away"] = "";
  card.dataset["state"] = "landed";
  card.style.cssText = "transform: translateY(4px); opacity: 0.5";
  const head = document.createElement("span");
  head.className = "card-head";
  head.id = "head-1";
  head.dataset["pose"] = "working";
  card.append(head);
  document.body.append(card);
  return card;
};

describe("copyCardForMotion", () => {
  it("keeps the card's words and what the stylesheet draws it by", () => {
    const copy = copyCardForMotion(buildCard());

    expect(copy.className).toBe("desk-card");
    expect(copy.dataset["state"]).toBe("landed");
    expect(copy.querySelector<HTMLElement>(".card-head")?.dataset["pose"]).toBe("working");
  });

  it("is no card to a lookup, the keyboard or a screen reader", () => {
    const copy = copyCardForMotion(buildCard());
    document.body.append(copy);

    expect(document.querySelectorAll("[data-card-id]")).toHaveLength(1);
    expect(copy.querySelector("#head-1")).toBeNull();
    for (const name of ["id", "role", "tabindex", "aria-label", "data-stage", "data-away"]) {
      expect(copy.hasAttribute(name)).toBe(false);
    }
    expect(copy.getAttribute("aria-hidden")).toBe("true");
    expect(copy.inert).toBe(true);
  });

  it("leaves the card as it was, and carries none of its inline style", () => {
    const card = buildCard();

    const copy = copyCardForMotion(card);

    expect(copy.getAttribute("style")).toBeNull();
    expect(card.id).toBe("card-1");
    expect(card.style.opacity).toBe("0.5");
  });

  it("keeps the colours of a row's wait and sentence", () => {
    const row = document.createElement("div");
    const wait = document.createElement("span");
    wait.dataset["level"] = "over";
    const sentence = document.createElement("span");
    sentence.dataset["tone"] = "bad";
    row.append(wait, sentence);
    document.body.append(row);

    const copy = copyCardForMotion(row);

    expect(copy.querySelector<HTMLElement>("[data-level]")?.dataset["level"]).toBe("over");
    expect(copy.querySelector<HTMLElement>("[data-tone]")?.dataset["tone"]).toBe("bad");
  });
});
