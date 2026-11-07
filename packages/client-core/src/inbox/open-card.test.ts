/** Tests what the open card says, with invented tickets of the Acme world. */
import { describe, expect, it } from "vitest";
import { buildInboxCard, buildInboxPlace } from "./cards.testing";
import { decideOpenCard, KIND_UNAVAILABLE_REASON } from "./open-card";

const NOW = new Date("2026-11-06T09:00:00.000Z");
const NO_GRAPH = { places: [], edges: [] };

describe("decideOpenCard", () => {
  it("names the card on one line: its noun, its identifier, who it is about, and yours", () => {
    const card = buildInboxCard("7", { person: { name: "Noa" }, yours: true });

    expect(decideOpenCard(card, NO_GRAPH, true, NOW).meta).toEqual([
      "Ticket",
      "ACME-7",
      "Noa",
      "yours",
    ]);
  });

  it("lists both parents of a diamond and the place they share once", () => {
    const card = buildInboxCard("7", { ancestors: ["round-a", "round-b", "site"] });
    const graph = {
      places: [
        buildInboxPlace("round-a", "Round A"),
        buildInboxPlace("round-b", "Round B"),
        buildInboxPlace("site", "Depot"),
      ],
      edges: [
        { fromRef: card.ref, toRef: "round-a" },
        { fromRef: card.ref, toRef: "round-b" },
        { fromRef: "round-a", toRef: "site" },
        { fromRef: "round-b", toRef: "site" },
      ],
    };

    const refs = decideOpenCard(card, graph, true, NOW).places.map((place) => place.ref);

    expect(refs).toEqual(["round-a", "round-b", "site"]);
  });

  it("offers Take it and Dismiss on a card with no Task", () => {
    const card = buildInboxCard("7");

    expect(decideOpenCard(card, NO_GRAPH, true, NOW).moves).toEqual({ _tag: "free" });
  });

  it("offers only the Task on a card that has one, even when its plugin is off", () => {
    const card = buildInboxCard("7", { taskId: "task-1" });

    expect(decideOpenCard(card, NO_GRAPH, false, NOW).moves).toEqual({
      _tag: "task",
      taskId: "task-1",
    });
  });

  it("turns every move off with the reason when the card's plugin is not active", () => {
    const card = buildInboxCard("7");

    expect(decideOpenCard(card, NO_GRAPH, false, NOW).moves).toEqual({
      _tag: "off",
      reason: KIND_UNAVAILABLE_REASON,
    });
  });
});
