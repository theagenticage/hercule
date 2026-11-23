import { describe, expect, it } from "vitest";
import type { McpServer } from "@hercule/contract";
import type { McpListEditState } from "./edit-guard";
import {
  decideReplaceChoice,
  describeReplaceDialog,
  describeReplaceRefusal,
  findReplaceCandidates,
} from "./replace";
import { SENTRY_WORK, buildServer } from "./testing";

const urlServer = (id: string, name: string, url: string): McpServer =>
  buildServer(id, name, "", { source: { kind: "url", url, signIn: "none", signInOffered: null } });

const OFFER = { origin: "https://mcp.sentry.example" };

describe("findReplaceCandidates", () => {
  it("returns the servers added by URL on the offer's origin, in the order given", () => {
    const first = urlServer("s-1", "one", "https://mcp.sentry.example/mcp");
    const second = urlServer("s-2", "two", "https://mcp.sentry.example/sse?team=a");

    expect(
      findReplaceCandidates(OFFER, [
        first,
        urlServer("s-other", "other", "https://mcp.other.example/mcp"),
        SENTRY_WORK,
        second,
      ]),
    ).toEqual([first, second]);
  });

  it("tells ports and schemes apart, and ignores the case of the host and a default port", () => {
    const servers = [
      urlServer("s-port", "port", "https://mcp.sentry.example:8443/mcp"),
      urlServer("s-http", "http", "http://mcp.sentry.example/mcp"),
      urlServer("s-default", "default", "https://MCP.Sentry.example:443/mcp"),
    ];

    expect(findReplaceCandidates(OFFER, servers).map((server) => server.id)).toEqual(["s-default"]);
    expect(
      findReplaceCandidates({ origin: "https://mcp.sentry.example:8443" }, servers).map(
        (server) => server.id,
      ),
    ).toEqual(["s-port"]);
  });

  it("returns none when no server was added by URL, or the origin is not an address", () => {
    expect(findReplaceCandidates(OFFER, [SENTRY_WORK])).toEqual([]);
    expect(
      findReplaceCandidates({ origin: "not an origin" }, [
        urlServer("s-1", "one", "https://mcp.sentry.example/mcp"),
      ]),
    ).toEqual([]);
  });
});

describe("describeReplaceDialog", () => {
  it("words the title, the paragraph and the three lines", () => {
    const server = urlServer("s-1", "docs", "https://mcp.sentry.example/mcp");

    expect(
      describeReplaceDialog({ server, connection: { label: "webshop-prod" }, typeName: "Sentry" }),
    ).toEqual({
      title: "Replace the docs server you added?",
      body: "You added https://mcp.sentry.example/mcp by hand, with a sign-in of its own. Sentry · webshop-prod reaches the same server, and one address and account is one server.",
      lines: [
        { label: "Stays", text: "the name and the projects that name it." },
        { label: "Changes", text: "it acts through the Connection." },
        { label: "Goes", text: "the sign-in made by hand." },
      ],
    });
  });

  it("returns null for a server that is not added by URL", () => {
    expect(
      describeReplaceDialog({
        server: SENTRY_WORK,
        connection: { label: "work" },
        typeName: "Sentry",
      }),
    ).toBeNull();
  });
});

describe("decideReplaceChoice", () => {
  const chosen = urlServer("s-1", "docs", "https://mcp.sentry.example/mcp");
  const other = urlServer("s-2", "wiki", "https://mcp.sentry.example/sse");
  const decide = (servers: McpServer[]) =>
    decideReplaceChoice({ offer: OFFER, servers, chosenServerId: "s-1" });

  it("keeps the chosen server while it is a candidate, with another one beside it", () => {
    expect(decide([other, chosen])).toEqual({ kind: "chosen", server: chosen });
  });

  it("reports a change, with the candidates now, when the chosen server was deleted: another one is never taken in its place", () => {
    expect(decide([other])).toEqual({ kind: "changed", candidates: [other] });
    expect(decide([])).toEqual({ kind: "changed", candidates: [] });
  });

  it("reports a change when the chosen server moved onto a Connection", () => {
    expect(decide([SENTRY_WORK, other])).toEqual({ kind: "changed", candidates: [other] });
  });
});

describe("describeReplaceRefusal", () => {
  const stateWith = (refusal: McpListEditState["refusal"]): McpListEditState => ({
    blocked: false,
    refusal,
    unread: null,
  });

  it("returns the reason, and the winner when the refusal names one", () => {
    expect(
      describeReplaceRefusal(
        stateWith({
          kind: "refused",
          message: "Nothing was replaced. Gone.",
          existingServerId: "s-9",
        }),
      ),
    ).toEqual({ message: "Nothing was replaced. Gone.", winnerServerId: "s-9" });
    expect(
      describeReplaceRefusal(
        stateWith({ kind: "refused", message: "Nothing was replaced. Gone." }),
      ),
    ).toEqual({ message: "Nothing was replaced. Gone.", winnerServerId: null });
  });

  it("returns null while there is no refusal", () => {
    expect(describeReplaceRefusal(stateWith(null))).toBeNull();
  });
});
