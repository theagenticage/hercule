/**
 * `composerFields(catalogs, config, kind)` is every lock, dimming and blocker
 * the composer shows, decided once here so no component holds a reason
 * string. What matters: an active thread's fields are locked with
 * the sentence that says why, a draft that cannot start says so and carries
 * the login it needs, and the pill names the account only when the provider
 * has more than one.
 */
import { describe, expect, it } from "vitest";
import type { ModelOption, ProviderInstance, Runner } from "@hydra/contract";
import { BARE, instance, snapshot } from "../providers.testing";
import { composerFields, pendingModelNote } from "./composer-fields";

const runner = (overrides: Partial<Runner> & { id: string }): Runner => ({
  ...BARE,
  ...overrides,
});

const LOCAL = runner({ id: "r-local", name: "moss" });

const EFFORT: ModelOption = {
  id: "effort",
  label: "Reasoning effort",
  kind: "select",
  choices: [
    { value: "low", label: "Low" },
    { value: "high", label: "High" },
  ],
  default: "low",
};

const SONNET = {
  slug: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  isDefault: true,
  options: [EFFORT],
};
const HAIKU = { slug: "claude-haiku-5", name: "Claude Haiku 5", options: [] };

const CLAUDE = instance("claude-code", "Claude Code", [
  snapshot({ runnerId: LOCAL.id, models: [SONNET, HAIKU] }),
]);

/** A second instance of the same provider, so the pill has an account to name. */
const named = (id: string, name: string): ProviderInstance => ({
  ...CLAUDE,
  id,
  name,
});

const WORK = named("instance-claude-work", "work");
const PERSONAL = named("instance-claude-personal", "personal");

/** Probed on no machine at all: the instance exists, the catalog does not. */
const NOT_HERE = instance("claude-code", "Claude Code", []);

const LOGGED_OUT = instance("claude-code", "Claude Code", [
  snapshot({ runnerId: LOCAL.id, auth: { status: "unauthenticated" }, models: [] }),
]);

const catalogs = (instances: readonly ProviderInstance[]) => ({
  instances,
  runners: [LOCAL],
  localRunnerId: LOCAL.id,
});

const config = (overrides: Record<string, unknown> = {}) => ({
  instanceId: CLAUDE.id,
  model: SONNET.slug,
  accessMode: "approval-required" as const,
  runnerId: LOCAL.id,
  profileId: "p-unrestricted",
  options: {},
  ...overrides,
});

describe("composerFields", () => {
  it("locks the access mode, the workspace and the machine on an active thread, and never the model", () => {
    const fields = composerFields(catalogs([CLAUDE]), config(), "active");

    expect(fields.accessMode.locked).toBe("Create a new thread to change the access mode");
    expect(fields.workspace.locked).toBe("Create a new thread to change the workspace");
    expect(fields.machine.locked).toBe("Create a new thread to change the machine");
    expect(fields.model.locked).toBeNull();
  });

  it("locks nothing on a draft thread", () => {
    const fields = composerFields(catalogs([CLAUDE]), config(), "draft");

    expect(fields.accessMode.locked).toBeNull();
    expect(fields.workspace.locked).toBeNull();
    expect(fields.machine.locked).toBeNull();
    expect(fields.model.locked).toBeNull();
  });

  it("blocks a draft with no provider instance set up", () => {
    const fields = composerFields(
      catalogs([]),
      config({ instanceId: null, model: null, runnerId: null }),
      "draft",
    );

    expect(fields.blocked).toMatchObject({ reason: "no provider instance is set up" });
  });

  it("blocks a draft with no machine connected at all", () => {
    const fields = composerFields(
      { instances: [CLAUDE], runners: [], localRunnerId: null },
      config({ runnerId: null }),
      "draft",
    );

    expect(fields.blocked).toEqual({ reason: "no machine is connected", login: null });
  });

  it("blocks a draft whose instance is not on the machine it would run on", () => {
    const fields = composerFields(
      catalogs([NOT_HERE]),
      config({ instanceId: NOT_HERE.id, model: null, runnerId: null }),
      "draft",
    );

    expect(fields.blocked).toEqual({ reason: "Claude Code is not on moss", login: null });
  });

  it("blocks a draft whose instance is not logged in, naming the machine and carrying the login target", () => {
    const fields = composerFields(
      catalogs([LOGGED_OUT]),
      config({ instanceId: LOGGED_OUT.id, model: null, runnerId: null }),
      "draft",
    );

    expect(fields.blocked).toEqual({
      reason: "Claude Code is on moss but not logged in",
      login: { instanceId: LOGGED_OUT.id, runnerId: LOCAL.id, displayName: "Claude Code" },
    });
  });

  it("blocks nothing when the instance is logged in", () => {
    expect(composerFields(catalogs([CLAUDE]), config(), "draft").blocked).toBeNull();
  });

  it("has no options field when the current model declares no descriptors, and one when it does", () => {
    expect(
      composerFields(catalogs([CLAUDE]), config({ model: HAIKU.slug }), "draft").options,
    ).toBeNull();
    expect(composerFields(catalogs([CLAUDE]), config(), "draft").options).not.toBeNull();
  });

  it("names no account in the pill when the provider has one instance", () => {
    expect(composerFields(catalogs([CLAUDE]), config(), "draft").model.pill).toEqual({
      providerId: "claude-code",
      account: null,
      name: "Claude Sonnet 5",
    });
  });

  it("names the instance in the pill when the provider has more than one", () => {
    const fields = composerFields(
      catalogs([WORK, PERSONAL]),
      config({ instanceId: PERSONAL.id }),
      "draft",
    );

    expect(fields.model.pill).toEqual({
      providerId: "claude-code",
      account: "personal",
      name: "Claude Sonnet 5",
    });
  });
});

describe("composerFields: the access mode", () => {
  it("carries the mode in force and the four rows the menu offers under it", () => {
    const fields = composerFields(catalogs([CLAUDE]), config(), "draft");

    expect(fields.accessMode.value).toBe("approval-required");
    expect(fields.accessMode.rows.map((row) => row.mode)).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
  });

  it("offers no mode at all while no instance is set up, there being no provider to ask", () => {
    const fields = composerFields(catalogs([]), config({ instanceId: null }), "draft");

    expect(fields.accessMode.rows).toEqual([]);
  });
});

describe("composerFields: the machine", () => {
  it("names the machine the thread would be placed on", () => {
    expect(composerFields(catalogs([CLAUDE]), config(), "draft").machine.label).toBe("moss");
  });

  it("carries the fleet as rows, and which machine it speaks about", () => {
    const fields = composerFields(catalogs([CLAUDE]), config(), "draft");

    expect(fields.machine.rows.map((row) => row.runnerId)).toEqual([LOCAL.id]);
    expect(fields.machine.referenceId).toBe(LOCAL.id);
  });

  it("says there is no machine to name when the fleet holds none", () => {
    const fields = composerFields(
      { instances: [CLAUDE], runners: [], localRunnerId: null },
      config({ runnerId: null }),
      "draft",
    );

    expect(fields.machine.label).toBe("no machine");
  });
});

describe("pendingModelNote", () => {
  it("says the change applies on send while an active thread holds an unsent model pick", () => {
    expect(pendingModelNote("active", { model: "claude-opus-5" })).toBe(
      "model change applies on send",
    );
  });

  it("says nothing on a draft, whose picks go out with the thread's first message", () => {
    expect(pendingModelNote("draft", { model: "claude-opus-5" })).toBeNull();
  });

  it("says nothing when only the options were picked: the model itself is not changing", () => {
    expect(pendingModelNote("active", { options: { effort: "high" } })).toBeNull();
  });
});
