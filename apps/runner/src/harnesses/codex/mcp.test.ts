import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import type { AccessMode } from "@hercule/protocol";
import { SESSION_TOKEN_VARIABLE } from "../../credentials/helper";
import { decideMcpConfig } from "./mcp";
import type { Rpc, RpcError } from "./rpc";

const GATEWAY = { name: "tools", url: "http://127.0.0.1:7777/mcp" };
const DOCS = { name: "docs", url: "http://127.0.0.1:7777/docs" };
const CWD = "/work/repo";

/** Builds a `config/read` reply with one layer of the given source that sets these `mcp_servers`. */
const buildReplyWithLayer = (
  name: Record<string, unknown>,
  servers: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) => ({
  config: {},
  origins: {},
  layers: [{ name, version: "sha256:0", config: { mcp_servers: servers }, ...extra }],
});

const PROJECT = { type: "project", dotCodexFolder: "/work/repo/.codex" };

/** What a stub Codex was asked, and what it answers to `config/read`. */
const decide = async (
  answer: { readonly reply: unknown } | { readonly failure: RpcError },
  options: {
    readonly servers?: ReadonlyArray<{ name: string; url: string }>;
    readonly accessMode?: AccessMode;
  } = {},
) => {
  const asked: Array<{ readonly method: string; readonly params: unknown }> = [];
  const rpc: Rpc = {
    request: (method, params) => {
      asked.push({ method, params });
      return "reply" in answer ? Effect.succeed(answer.reply) : Effect.fail(answer.failure);
    },
    notify: () => undefined,
    answer: () => undefined,
    pump: Effect.void,
  };
  const decision = await Effect.runPromise(
    decideMcpConfig({
      rpc,
      cwd: CWD,
      servers: options.servers ?? [GATEWAY],
      accessMode: options.accessMode ?? "approval-required",
    }),
  );
  return { decision, asked };
};

/**
 * What the real Codex 0.171 replies for a fresh, empty `CODEX_HOME` and a
 * folder with no `.codex`: three layers, none of which sets an MCP server.
 */
const NONE = {
  reply: {
    config: {},
    origins: {},
    layers: [
      {
        name: { type: "sessionFlags" },
        version: "sha256:0",
        config: { check_for_update_on_startup: false },
      },
      {
        name: { type: "user", file: "/home/me/.codex/config.toml" },
        version: "sha256:1",
        config: {},
      },
      { name: { type: "system", file: "/etc/codex/config.toml" }, version: "sha256:1", config: {} },
    ],
  },
};

describe("deciding the MCP config of a Codex thread", () => {
  describe("when no layer sets a server's name", () => {
    it("gives the server's URL, the name of the token variable, and the tool list feature", async () => {
      const { decision, asked } = await decide(NONE);

      expect(decision).toEqual({
        config: {
          "mcp_servers.tools.url": GATEWAY.url,
          "mcp_servers.tools.bearer_token_env_var": SESSION_TOKEN_VARIABLE,
          "mcp_servers.tools.default_tools_approval_mode": "prompt",
          "features.mcp_tool_list_changed": true,
        },
        warnings: [],
      });
      expect(asked).toEqual([{ method: "config/read", params: { cwd: CWD, includeLayers: true } }]);
    });

    it.each([
      ["approval-required", "prompt"],
      ["auto-accept-edits", "prompt"],
      ["auto", "prompt"],
      ["full-access", "approve"],
    ] as const)("asks about calls in %s mode as %s", async (accessMode, approvalMode) => {
      const { decision } = await decide(NONE, { accessMode });

      expect(decision.config).toMatchObject({
        "mcp_servers.tools.default_tools_approval_mode": approvalMode,
      });
    });
  });

  it("makes no request, and gives no config, for a session with no MCP server", async () => {
    const { decision, asked } = await decide(NONE, { servers: [] });

    expect(decision).toEqual({ config: undefined, warnings: [] });
    expect(asked).toEqual([]);
  });

  describe("when a layer sets the name of a server", () => {
    it.each([
      ["a key of its table", { tools: { url: "http://example.test/mcp" } }],
      ["a nested key", { tools: { tools: { x: { approval_mode: "approve" } } } }],
      ["the table with nothing in it", { tools: {} }],
    ])("gives no config, and warns with the folder and the fix, for %s", async (_name, servers) => {
      const { decision } = await decide({ reply: buildReplyWithLayer(PROJECT, servers) });

      expect(decision.config).toBeUndefined();
      expect(decision.warnings).toHaveLength(1);
      expect(decision.warnings[0]).toContain("/work/repo/.codex");
      expect(decision.warnings[0]).toContain("config.toml");
      expect(decision.warnings[0]).toContain('MCP server named "tools"');
      expect(decision.warnings[0]).toContain("Rename or remove");
    });

    it("counts a project layer that is not trusted yet, because starting the thread trusts it", async () => {
      const reply = buildReplyWithLayer(
        PROJECT,
        { tools: { enabled: false } },
        { disabledReason: "this project is not trusted" },
      );

      const { decision } = await decide({ reply });

      expect(decision.config).toBeUndefined();
      expect(decision.warnings[0]).toContain("/work/repo/.codex");
    });

    it("names the file of a layer that is a file, and the kind of any other", async () => {
      const file = { type: "user", file: "/home/me/.codex/config.toml" };

      const fromFile = await decide({ reply: buildReplyWithLayer(file, { tools: {} }) });
      const fromOther = await decide({
        reply: buildReplyWithLayer({ type: "sessionFlags" }, { tools: {} }),
      });

      expect(fromFile.decision.warnings[0]).toContain("/home/me/.codex/config.toml");
      expect(fromOther.decision.warnings[0]).toContain("sessionFlags");
    });

    it("is not fooled by another server's name, or by one that only starts like it", async () => {
      const { decision } = await decide({
        reply: buildReplyWithLayer(PROJECT, { docs: { command: "docs-server" }, tools_extra: {} }),
      });

      expect(decision.config).toMatchObject({ "mcp_servers.tools.url": GATEWAY.url });
      expect(decision.warnings).toEqual([]);
    });

    it("leaves out only the server whose name is taken, and warns for it", async () => {
      const { decision } = await decide(
        { reply: buildReplyWithLayer(PROJECT, { docs: { command: "docs-server" } }) },
        { servers: [GATEWAY, DOCS] },
      );

      expect(decision.config).toMatchObject({ "mcp_servers.tools.url": GATEWAY.url });
      expect(decision.config).not.toHaveProperty(["mcp_servers.docs.url"]);
      expect(decision.warnings).toHaveLength(1);
      expect(decision.warnings[0]).toContain('"docs"');
    });
  });

  describe("when the configuration cannot be read", () => {
    it("gives no config, and warns with Codex's own message, when the request fails", async () => {
      const { decision } = await decide({
        failure: { message: "invalid transport in `mcp_servers.tools`" },
      });

      expect(decision.config).toBeUndefined();
      expect(decision.warnings).toHaveLength(1);
      expect(decision.warnings[0]).toContain("invalid transport in `mcp_servers.tools`");
    });

    const FILE = { type: "user", file: "/home/me/.codex/config.toml" };

    it.each([
      ["no layers", { config: {} }],
      ["an empty list of layers, which a real reply never has", { config: {}, layers: [] }],
      ["layers that are null", { config: {}, layers: null }],
      ["layers that are not a list", { config: {}, layers: "nothing" }],
      ["a reply that is not an object", "nothing"],
      ["a layer with no settings", { layers: [{ name: FILE }] }],
      ["a layer whose settings are not an object", { layers: [{ name: FILE, config: "nothing" }] }],
      ["a layer whose settings are a list", { layers: [{ name: FILE, config: [] }] }],
      ["a layer with no source", { layers: [{ config: {} }] }],
    ])(
      "gives no config, and warns that the reply was not understood, for %s",
      async (_name, reply) => {
        const { decision } = await decide({ reply });

        expect(decision.config).toBeUndefined();
        expect(decision.warnings).toHaveLength(1);
        expect(decision.warnings[0]).toContain("not understood");
      },
    );

    it("counts one unreadable layer among readable ones as unread", async () => {
      const { decision } = await decide({
        reply: { layers: [{ name: FILE, config: {} }, { name: FILE }] },
      });

      expect(decision.config).toBeUndefined();
      expect(decision.warnings[0]).toContain("not understood");
    });
  });
});
