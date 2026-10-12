import { describe, expect, it } from "vitest";
import type { Connection } from "@hercule/contract";
import {
  decideFieldChoices,
  describeConnectionHealth,
  describeConnectionTypeName,
  findOAuthConnection,
  listFlowSwitches,
  summarizeConnectionType,
} from "./connection-settings";
import type { ConnectionType } from "./connections";
import { ApiError, readErrorMessage } from "./errors";

const withSetup = (setup: ConnectionType["setup"]): ConnectionType => ({
  type: "p/t",
  displayName: "T",
  pluginName: "P",
  setup,
  feeds: [],
});

const CONNECTION = {
  id: "0199c0ff-aaaa-7000-8000-000000000001",
  type: "p/t",
  label: "work",
  displayName: "work",
  status: "connected",
  labels: [],
  config: {},
  feedIntervals: {},
  credentials: [{ name: "token", rotatedAt: "2026-10-02T08:15:00.000Z" }],
  createdAt: "2026-10-02T08:15:00.000Z",
  updatedAt: "2026-10-02T08:15:00.000Z",
} satisfies Connection;

describe("describeConnectionHealth", () => {
  it("words every status, drawing only an error as a failure", () => {
    expect(describeConnectionHealth({ status: "connected" })).toEqual({
      text: "healthy",
      failing: false,
    });
    expect(describeConnectionHealth({ status: "needs-reauth" })).toEqual({
      text: "needs sign-in",
      failing: false,
    });
    expect(describeConnectionHealth({ status: "disabled" })).toEqual({
      text: "disabled",
      failing: false,
    });
    expect(
      describeConnectionHealth({ status: "error", statusDetail: "rate limited by GitHub" }),
    ).toEqual({ text: "rate limited by GitHub", failing: true });
  });

  it("says error when the controller gave no detail", () => {
    expect(describeConnectionHealth({ status: "error" }).text).toBe("error");
    expect(describeConnectionHealth({ status: "error", statusDetail: "  " }).text).toBe("error");
  });
});

describe("describeConnectionTypeName", () => {
  it("is the type's display name when the type is known", () => {
    expect(describeConnectionTypeName(CONNECTION, withSetup([]))).toBe("T");
  });

  it("is the raw type when no plugin declares the type", () => {
    expect(describeConnectionTypeName(CONNECTION, undefined)).toBe("p/t");
  });
});

describe("summarizeConnectionType", () => {
  it("leads with the plugin, then joins the flows, reading two sign-ins as one", () => {
    const type = withSetup([
      { kind: "device" },
      { kind: "oauth" },
      { kind: "credentials", fields: [{ name: "pat", label: "Token" }] },
    ]);
    expect(summarizeConnectionType(type)).toBe("P · sign in with T or paste a token");
  });

  it("describes a pairing setup", () => {
    expect(summarizeConnectionType(withSetup([{ kind: "pairing" }]))).toBe(
      "P · pair a chat account",
    );
  });

  it("leaves out a plugin named like its type", () => {
    expect(summarizeConnectionType({ ...withSetup([{ kind: "device" }]), pluginName: "T" })).toBe(
      "sign in with T",
    );
  });

  it("shows the type's id for a setup this build cannot show", () => {
    expect(summarizeConnectionType({ ...withSetup([]), pluginName: "T" })).toBe("p/t");
  });
});

describe("listFlowSwitches", () => {
  const token = {
    kind: "credentials",
    fields: [{ name: "pat", label: "Personal access token" }],
  } as const;

  it("offers every flow but the current one, in declared order", () => {
    const type = withSetup([{ kind: "device" }, token]);
    expect(listFlowSwitches(type, "device")).toEqual([
      { flow: "credentials", label: "Paste a token instead" },
    ]);
    expect(listFlowSwitches(type, "credentials")).toEqual([
      { flow: "device", label: "Sign in with T instead" },
    ]);
  });

  it("never offers pairing, which no screen can run yet", () => {
    const type = withSetup([token, { kind: "pairing" }]);
    expect(listFlowSwitches(type, "credentials")).toEqual([]);
  });

  it("tells the two sign-in flows apart when the type offers both", () => {
    const type = withSetup([{ kind: "device" }, { kind: "oauth" }, token]);
    expect(listFlowSwitches(type, "credentials")).toEqual([
      { flow: "device", label: "Sign in with a code instead" },
      { flow: "oauth", label: "Sign in with T in the browser instead" },
    ]);
  });

  it("names a redirect sign-in after the provider when it is the only sign-in", () => {
    expect(listFlowSwitches(withSetup([token, { kind: "oauth" }]), "credentials")).toEqual([
      { flow: "oauth", label: "Sign in with T instead" },
    ]);
  });

  it("names the one field a credentials flow asks for when it is not a token", () => {
    const apiKey = withSetup([
      { kind: "device" },
      { kind: "credentials", fields: [{ name: "key", label: "API key" }] },
    ]);
    expect(listFlowSwitches(apiKey, "device")).toEqual([
      { flow: "credentials", label: "Enter your API key instead" },
    ]);
    const password = withSetup([
      { kind: "device" },
      { kind: "credentials", fields: [{ name: "password", label: "Password" }] },
    ]);
    expect(listFlowSwitches(password, "device")).toEqual([
      { flow: "credentials", label: "Enter your password instead" },
    ]);
  });

  it("asks for credentials when the flow has several fields", () => {
    const type = withSetup([
      { kind: "oauth" },
      {
        kind: "credentials",
        fields: [
          { name: "token", label: "Bot token" },
          { name: "secret", label: "Signing secret" },
        ],
      },
    ]);
    expect(listFlowSwitches(type, "oauth")).toEqual([
      { flow: "credentials", label: "Enter credentials instead" },
    ]);
  });
});

describe("findOAuthConnection", () => {
  const added = { ...CONNECTION, id: "0199c0ff-aaaa-7000-8000-000000000002" };
  const otherType = { ...added, type: "p/other" };
  const reconnect = { type: "p/t", connectionId: CONNECTION.id };
  const later = "2026-10-02T09:00:00.000Z";
  const waiting = { ...CONNECTION, status: "needs-reauth" as const };

  it("finds a new Connection of the type", () => {
    expect(findOAuthConnection([CONNECTION], [CONNECTION, added], { type: "p/t" })).toBe(added);
  });

  it("finds nothing while no new Connection of the type is there", () => {
    expect(findOAuthConnection([CONNECTION], [CONNECTION], { type: "p/t" })).toBeUndefined();
    expect(
      findOAuthConnection([CONNECTION], [CONNECTION, otherType], { type: "p/t" }),
    ).toBeUndefined();
  });

  it("finds a reconnected Connection once its credential is rotated and it is connected", () => {
    const after = { ...CONNECTION, credentials: [{ name: "token", rotatedAt: later }] };
    expect(findOAuthConnection([waiting], [after], reconnect)).toBe(after);
  });

  it("finds a reconnected Connection that gained a credential under a new name", () => {
    const after = {
      ...CONNECTION,
      credentials: [...CONNECTION.credentials, { name: "refresh", rotatedAt: later }],
    };
    expect(findOAuthConnection([waiting], [after], reconnect)).toBe(after);
  });

  it("does not count a write that replaced no credential", () => {
    const renamed = { ...CONNECTION, label: "renamed", updatedAt: later };
    const configured = { ...CONNECTION, config: { org: "acme" }, updatedAt: later };
    const recovered = { ...CONNECTION, updatedAt: later };
    expect(findOAuthConnection([CONNECTION], [renamed], reconnect)).toBeUndefined();
    expect(findOAuthConnection([CONNECTION], [configured], reconnect)).toBeUndefined();
    expect(findOAuthConnection([waiting], [recovered], reconnect)).toBeUndefined();
  });

  it("does not count a rotated credential while the Connection is not connected", () => {
    const after = { ...waiting, credentials: [{ name: "token", rotatedAt: later }] };
    expect(findOAuthConnection([waiting], [after], reconnect)).toBeUndefined();
  });

  it("finds nothing when the Connection is gone from the later list", () => {
    expect(findOAuthConnection([waiting], [], reconnect)).toBeUndefined();
  });

  it("reads every credential as new when the earlier list did not have the Connection", () => {
    expect(findOAuthConnection([], [CONNECTION], reconnect)).toBe(CONNECTION);
    const noCredentials = { ...CONNECTION, credentials: [] };
    expect(findOAuthConnection([], [noCredentials], reconnect)).toBeUndefined();
  });
});

describe("decideFieldChoices", () => {
  const choices = [{ value: "acme", label: "Acme" }];

  it("is loading until the data is there", () => {
    expect(decideFieldChoices({ isError: false, error: null, data: undefined })).toEqual({
      status: "loading",
    });
  });

  it("is loaded with the data", () => {
    expect(decideFieldChoices({ isError: false, error: null, data: choices })).toEqual({
      status: "loaded",
      choices,
    });
  });

  it("is failed with the error's message, even when older data is there", () => {
    const error = new ApiError("internal", "GitHub is down");
    expect(decideFieldChoices({ isError: true, error, data: choices })).toEqual({
      status: "failed",
      message: readErrorMessage(error),
    });
  });
});
