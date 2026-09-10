/**
 * `modelMenu(instances, runner, current)` groups a provider instance's models
 * per instance, for the composer's model selector.
 */
import { describe, expect, it } from "vitest";
import type { ModelOption } from "@hydra/contract";
import { modelMenu } from "./model-menu";
import { BARE, instance, snapshot } from "../providers.testing";

const RUNNER = { id: BARE.id, name: BARE.name };

const reasoningOption: ModelOption = {
  id: "effort",
  label: "Reasoning effort",
  kind: "select",
  choices: [
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ],
  default: "medium",
};

const claudeCode = instance("claude-code", "Claude Code", [
  snapshot({
    runnerId: RUNNER.id,
    auth: { status: "ok", identity: "rogier@example.com", planLabel: "Claude Max" },
    models: [
      {
        slug: "claude-sonnet-5",
        name: "Claude Sonnet 5",
        isDefault: true,
        options: [reasoningOption],
      },
      { slug: "claude-opus-5", name: "Claude Opus 5", isLegacy: true, options: [] },
    ],
  }),
]);

const codex = instance("codex", "Codex", [
  snapshot({ runnerId: RUNNER.id, auth: { status: "unauthenticated" }, models: [] }),
]);

const erroredInstance = instance("pi-error", "pi (stale probe)", [
  snapshot({
    runnerId: RUNNER.id,
    auth: { status: "error", message: "the harness did not answer" },
    models: [],
  }),
]);

const freshInstall = instance("pi", "pi", []); // no snapshot at all on any runner

describe("modelMenu", () => {
  it("builds one group per instance, in order, with header fields from the picked runner's snapshot", () => {
    const groups = modelMenu([claudeCode, codex], RUNNER, {
      instanceId: claudeCode.id,
      model: "claude-sonnet-5",
    });

    expect(groups.map((group) => group.instanceId)).toEqual([claudeCode.id, codex.id]);
    expect(groups[0]).toMatchObject({
      displayName: "Claude Code",
      name: "Claude Code",
      identity: "rogier@example.com",
      planLabel: "Claude Max",
      dimmed: null,
    });
  });

  it("dims an instance with no usable login on this runner, unauthenticated or errored, with the runner named", () => {
    const groups = modelMenu([claudeCode, codex, erroredInstance], RUNNER, {
      instanceId: claudeCode.id,
      model: "claude-sonnet-5",
    });

    expect(groups.find((group) => group.instanceId === codex.id)).toMatchObject({
      dimmed: `not logged in on ${RUNNER.name}`,
    });
    expect(groups.find((group) => group.instanceId === erroredInstance.id)).toMatchObject({
      dimmed: `not logged in on ${RUNNER.name}`,
    });
  });

  it("dims an instance with no snapshot at all on this runner as found, not logged in", () => {
    const groups = modelMenu([claudeCode, freshInstall], RUNNER, {
      instanceId: claudeCode.id,
      model: "claude-sonnet-5",
    });

    expect(groups.find((group) => group.instanceId === freshInstall.id)).toMatchObject({
      dimmed: "found, not logged in",
    });
  });

  it("expands only the group matching current.instanceId", () => {
    const groups = modelMenu([claudeCode, codex], RUNNER, {
      instanceId: codex.id,
      model: "irrelevant",
    });

    expect(groups.find((group) => group.instanceId === claudeCode.id)!.expanded).toBe(false);
    expect(groups.find((group) => group.instanceId === codex.id)!.expanded).toBe(true);
  });

  it("carries isDefault and isLegacy through from the descriptor", () => {
    const groups = modelMenu([claudeCode], RUNNER, {
      instanceId: claudeCode.id,
      model: "claude-sonnet-5",
    });

    const models = groups[0]!.models;
    expect(models.find((model) => model.slug === "claude-sonnet-5")).toMatchObject({
      isDefault: true,
      isLegacy: false,
    });
    expect(models.find((model) => model.slug === "claude-opus-5")).toMatchObject({
      isDefault: false,
      isLegacy: true,
    });
  });

  it("adds a dimmed row for a current model slug the runner's snapshot does not list", () => {
    const groups = modelMenu([claudeCode], RUNNER, {
      instanceId: claudeCode.id,
      model: "claude-haiku-5",
    });

    const row = groups[0]!.models.find((model) => model.slug === "claude-haiku-5");
    expect(row).toMatchObject({
      dimmed: `not offered on ${RUNNER.name}`,
      current: true,
      options: [],
    });
  });

  it("speaks without naming a machine when there is no runner at all", () => {
    const groups = modelMenu([claudeCode, freshInstall], null, {
      instanceId: claudeCode.id,
      model: "claude-haiku-5",
    });

    expect(groups.find((group) => group.instanceId === freshInstall.id)).toMatchObject({
      dimmed: "found, not logged in",
    });
    const missingRow = groups
      .find((group) => group.instanceId === claudeCode.id)!
      .models.find((model) => model.slug === "claude-haiku-5");
    expect(missingRow).toMatchObject({ dimmed: "not offered on this runner" });
  });

  it("adds no missing row when no model is picked at all", () => {
    const groups = modelMenu([claudeCode], RUNNER, { instanceId: claudeCode.id, model: null });

    expect(groups[0]!.models.every((row) => row.dimmed === null)).toBe(true);
    expect(groups[0]!.models.every((row) => !row.current)).toBe(true);
  });

  it("carries the current model's option descriptors through verbatim", () => {
    const groups = modelMenu([claudeCode], RUNNER, {
      instanceId: claudeCode.id,
      model: "claude-sonnet-5",
    });

    const row = groups[0]!.models.find((model) => model.slug === "claude-sonnet-5");
    expect(row!.current).toBe(true);
    expect(row!.dimmed).toBeNull();
    expect(row!.options).toEqual([reasoningOption]);
  });
});
