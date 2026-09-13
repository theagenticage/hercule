import { describe, expect, it } from "vitest";
import type { PluginDetail } from "@hydra/contract";
import { connectionIssues, connectionTypes, redirectUriFor } from "./connections";
import { ApiError } from "./errors";

describe("redirectUriFor", () => {
  it("is the callback path on the origin the browser is at", () => {
    expect(redirectUriFor("https://n.tail.ts.net")).toBe("https://n.tail.ts.net/oauth/callback");
  });

  it("does not double the slash when the origin carries a trailing one", () => {
    expect(redirectUriFor("https://n.tail.ts.net/")).toBe("https://n.tail.ts.net/oauth/callback");
  });
});

/** A catalogued plugin, with whatever it contributes. */
const plugin = (
  id: string,
  enabled: boolean,
  contributions: PluginDetail["contributions"],
): PluginDetail => ({
  id,
  displayName: id,
  hostApi: 1,
  capabilities: ["connections"],
  enabled,
  status: { _tag: "active" },
  config: {},
  contributions,
});

const PAPER = {
  type: "paper",
  displayName: "Paper Trail",
  setup: [{ kind: "credentials", fields: [{ name: "token", label: "Access token" }] }],
  configSchema: { type: "object", properties: { folder: { type: "string" } } },
};

describe("connectionTypes", () => {
  it("is every connection-type contribution, with the plugin that declared it", () => {
    const types = connectionTypes([
      plugin("paper-trail", false, [
        { extensionPoint: "connection-type", id: "paper", definition: PAPER },
      ]),
      plugin("quiet-sink", true, [{ extensionPoint: "provider", id: "acme", definition: {} }]),
    ]);

    expect(types).toEqual([
      {
        pluginId: "paper-trail",
        pluginEnabled: false,
        type: "paper",
        displayName: "Paper Trail",
        setup: PAPER.setup,
        configSchema: PAPER.configSchema,
      },
    ]);
  });

  it("leaves out a definition that names no type", () => {
    expect(
      connectionTypes([
        plugin("broken", true, [{ extensionPoint: "connection-type", id: "x", definition: 7 }]),
      ]),
    ).toEqual([]);
  });
});

describe("connectionIssues", () => {
  const refusal = (path: ReadonlyArray<string>) =>
    new ApiError("validation", "refused", { issues: [{ path, message: "no" }] });

  it("puts an issue naming the group under the field it names", () => {
    expect(connectionIssues(refusal(["credentials", "token"]), "credentials")).toEqual({
      perField: { token: "no" },
      rest: false,
    });
  });

  it("counts an issue about another group as the form's own failure", () => {
    expect(connectionIssues(refusal(["config", "folder"]), "credentials")).toEqual({
      perField: {},
      rest: true,
    });
  });

  it("has nothing to say about no error, and everything about another failure", () => {
    expect(connectionIssues(null, "config")).toEqual({ perField: {}, rest: false });
    expect(connectionIssues(new Error("offline"), "config")).toEqual({
      perField: {},
      rest: true,
    });
  });
});
