import { describe, expect, it } from "vitest";
import { ConnectionStatus, type Connection } from "@hercule/contract";
import { connectionNeedsAttention, showsAccountBesideLabel } from "./connections";

describe("connectionNeedsAttention", () => {
  it("is true only for a Connection in error or waiting to be signed in again", () => {
    const needsAttention: ReadonlyArray<ConnectionStatus> = ["error", "needs-reauth"];
    for (const status of ConnectionStatus.literals) {
      expect(connectionNeedsAttention({ status }), status).toBe(needsAttention.includes(status));
    }
  });
});

describe("showsAccountBesideLabel", () => {
  const connection = {
    id: "0199c0ff-aaaa-7000-8000-000000000001",
    type: "github/github",
    label: "octocat",
    displayName: "octocat",
    status: "connected",
    labels: [],
    config: {},
    feedIntervals: {},
    credentials: [],
    createdAt: "2026-10-02T08:15:00.000Z",
    updatedAt: "2026-10-02T08:15:00.000Z",
  } satisfies Connection;

  it("is false for a connection whose name is its account name", () => {
    expect(showsAccountBesideLabel(connection)).toBe(false);
  });

  it("is true once the connection is renamed, though the account stays the same", () => {
    expect(showsAccountBesideLabel({ ...connection, label: "personal" })).toBe(true);
  });

  it("is false for an account with no name, which the type's name stands in for", () => {
    expect(showsAccountBesideLabel({ ...connection, label: "GitHub", displayName: "" })).toBe(
      false,
    );
    expect(showsAccountBesideLabel({ ...connection, label: "GitHub", displayName: "  " })).toBe(
      false,
    );
  });
});
