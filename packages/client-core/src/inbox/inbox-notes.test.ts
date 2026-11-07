/** Tests the quiet lines about a truncated Inbox and a source that cannot be read. */
import { describe, expect, it } from "vitest";
import { buildInbox, buildSourceConnection, buildSourcePlugin } from "./cards.testing";
import { describeFailingSources, describeTruncatedInbox } from "./inbox-notes";

const ACME = buildSourcePlugin("acme", "Acme", [{ word: "acme/ticket" }]);
const QUAYSIDE = buildSourcePlugin("quayside", "Quayside", [{ word: "quayside/order" }]);
const PLAIN = buildSourcePlugin("plain", "Plain");
const PLUGINS = [ACME, QUAYSIDE, PLAIN];

describe("describeTruncatedInbox", () => {
  it("says nothing for an Inbox that shows every card", () => {
    expect(describeTruncatedInbox(buildInbox([]))).toBeUndefined();
  });

  it("says that more exist, and what lets them in", () => {
    expect(describeTruncatedInbox({ ...buildInbox([]), truncated: true })).toBe(
      "The Inbox shows the first 1,000 cards, and more exist. Dismiss or take on some to bring the rest in.",
    );
  });
});

describe("describeFailingSources", () => {
  it("says nothing while every source answers", () => {
    const connections = [buildSourceConnection("c1", "acme/account")];
    expect(describeFailingSources(connections, PLUGINS)).toBeUndefined();
  });

  it("names a source that needs signing in again, and what it means for its cards", () => {
    const connections = [buildSourceConnection("c1", "acme/account", { status: "needs-reauth" })];
    expect(describeFailingSources(connections, PLUGINS)).toBe(
      "Acme needs you to sign in again. Its cards may be out of date.",
    );
  });

  it("names a source that failed", () => {
    const connections = [buildSourceConnection("c1", "acme/account", { status: "error" })];
    expect(describeFailingSources(connections, PLUGINS)).toBe(
      "Acme stopped answering. Its cards may be out of date.",
    );
  });

  it("names each plugin once when several Connections or plugins fail", () => {
    const twoAccounts = [
      buildSourceConnection("c1", "acme/account", { status: "error" }),
      buildSourceConnection("c2", "acme/account", { status: "error" }),
    ];
    expect(describeFailingSources(twoAccounts, PLUGINS)).toBe(
      "Acme stopped answering. Its cards may be out of date.",
    );
    const twoPlugins = [
      buildSourceConnection("c1", "acme/account", { status: "error" }),
      buildSourceConnection("c3", "quayside/account", { status: "needs-reauth" }),
    ];
    expect(describeFailingSources(twoPlugins, PLUGINS)).toBe(
      "Acme and Quayside are not answering. Their cards may be out of date.",
    );
  });

  it("leaves out a disabled Connection and a plugin that declares no cards", () => {
    const connections = [
      buildSourceConnection("c1", "acme/account", { status: "disabled" }),
      buildSourceConnection("c2", "plain/account", { status: "error" }),
    ];
    expect(describeFailingSources(connections, PLUGINS)).toBeUndefined();
  });

  it("says the warning of a Connection when it is the Inbox's own, and no other", () => {
    const own = "The Inbox may be missing items: the Acme ticket list could only be read in part.";
    expect(
      describeFailingSources(
        [buildSourceConnection("c1", "acme/account", { warning: own })],
        PLUGINS,
      ),
    ).toBe(own);
    expect(
      describeFailingSources(
        [buildSourceConnection("c1", "acme/account", { warning: "This token cannot read mail." })],
        PLUGINS,
      ),
    ).toBeUndefined();
  });
});
