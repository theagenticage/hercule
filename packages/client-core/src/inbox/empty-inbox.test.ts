/** Tests what an Inbox with no card draws: the first run with its offers, or the all clear. */
import { describe, expect, it } from "vitest";
import {
  buildInbox,
  buildInboxCard,
  buildSourceConnection,
  buildSourcePlugin,
} from "./cards.testing";
import { decideEmptyInbox, listSourceOffers } from "./empty-inbox";

const ACME = buildSourcePlugin("acme", "Acme", [
  { word: "acme/review", card: "compact", connect: "Reviews people ask of you" },
  { word: "acme/ticket", connect: "Tickets, with their projects" },
  { word: "acme/project", pace: "context" },
]);
const QUAYSIDE = buildSourcePlugin("quayside", "Quayside", [
  { word: "quayside/order", connect: "Orders waiting for your sign-off" },
]);
const PLAIN = buildSourcePlugin("plain", "Plain");

describe("listSourceOffers", () => {
  it("offers a plugin once for each side its kinds lie on, rich kinds under Ongoing", () => {
    expect(listSourceOffers([QUAYSIDE, ACME, PLAIN])).toEqual([
      { pluginId: "acme", name: "Acme", line: "Tickets, with their projects", side: "ongoing" },
      {
        pluginId: "quayside",
        name: "Quayside",
        line: "Orders waiting for your sign-off",
        side: "ongoing",
      },
      { pluginId: "acme", name: "Acme", line: "Reviews people ask of you", side: "requests" },
    ]);
  });

  it("offers nothing for a context kind or a kind with no connect line", () => {
    const plugin = buildSourcePlugin("quiet", "Quiet", [
      { word: "quiet/place", pace: "context", connect: "Where things live" },
      { word: "quiet/thing" },
    ]);
    expect(listSourceOffers([plugin])).toEqual([]);
  });
});

describe("decideEmptyInbox", () => {
  it("has nothing to say about an Inbox with cards", () => {
    const inbox = buildInbox([buildInboxCard("1")]);
    expect(decideEmptyInbox(inbox, [], [ACME])).toBeNull();
  });

  it("is a first run when no Connection belongs to a plugin that declares cards", () => {
    const connections = [buildSourceConnection("c1", "plain/account")];
    expect(decideEmptyInbox(buildInbox([]), connections, [ACME, PLAIN])).toEqual({
      _tag: "first-run",
      offers: listSourceOffers([ACME, PLAIN]),
    });
  });

  it("is all clear when no plugin offers a source to connect", () => {
    expect(decideEmptyInbox(buildInbox([]), [], [PLAIN])).toEqual({ _tag: "all-clear" });
  });

  it("is all clear once a source is connected, whatever its status", () => {
    const connections = [buildSourceConnection("c1", "acme/account", { status: "needs-reauth" })];
    expect(decideEmptyInbox(buildInbox([]), connections, [ACME])).toEqual({ _tag: "all-clear" });
  });
});
