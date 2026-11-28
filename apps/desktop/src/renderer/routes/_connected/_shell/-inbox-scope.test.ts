/** Tests how the Inbox's scope is written into the URL's search params and read back. */
import { describe, expect, it } from "vitest";
import type { InboxScope } from "@hercule/client-core/inbox";
import {
  DEFAULT_INBOX_SCOPE,
  buildInboxScopeParams,
  readInboxScope,
  validateInboxScopeParams,
} from "./-inbox-scope";

const roundTrip = (scope: InboxScope): InboxScope =>
  readInboxScope(validateInboxScopeParams({ ...buildInboxScopeParams(scope) }));

describe("the Inbox's scope in the URL", () => {
  it("opens on the waits list when the URL names nothing, and writes nothing for it", () => {
    expect(readInboxScope(validateInboxScopeParams({}))).toEqual(DEFAULT_INBOX_SCOPE);
    expect(buildInboxScopeParams(DEFAULT_INBOX_SCOPE)).toEqual({ list: undefined });
  });

  it("keeps a saved query and a Browse value, with its account, through a round trip", () => {
    const saved: InboxScope = { kind: "saved-query", id: "mine" };
    const value: InboxScope = {
      kind: "value",
      value: { source: "linear", key: "team", value: "Checkout", connectionId: "c2" },
    };

    expect(roundTrip(saved)).toEqual(saved);
    expect(roundTrip(value)).toEqual(value);
  });

  it("drops what is not a short text, and a Browse value that is only partly there", () => {
    expect(validateInboxScopeParams({ list: 7, source: "linear", key: "team" })).toEqual({
      list: undefined,
      source: undefined,
      key: undefined,
      value: undefined,
      account: undefined,
    });
    expect(validateInboxScopeParams({ list: "x".repeat(500) }).list).toBeUndefined();
  });
});
