/**
 * Tests `buildAssistantProviderField(instances, assistant)`, which builds the
 * Provider field of Settings > Assistants: one group per provider instance,
 * its default model first, the account as the hint.
 */
import { describe, expect, it } from "vitest";
import type { ProviderInstance } from "@hercule/contract";
import { toIdTail } from "../id-tail";
import { buildAssistantProviderField } from "./provider-field";

const PERSONAL = "01a06d02-7600-7000-8000-000000000001";
const WORK = "01a06d02-7600-7000-8000-000000000002";
const CODEX = "01a06d02-7600-7000-8000-000000000003";

const buildInstance = (
  id: string,
  providerId: string,
  name: string,
  displayName: string,
  auth: ProviderInstance["snapshots"][number]["auth"] | null,
): ProviderInstance => ({
  id,
  providerId,
  name,
  config: {},
  displayName,
  binaryName: providerId,
  declared: {} as ProviderInstance["declared"],
  secretFields: [],
  snapshots:
    auth === null
      ? []
      : [
          {
            runnerId: "01a06d02-7700-7000-8000-000000000001",
            probedAt: "2026-09-05T09:14:00.000Z",
            harnessVersion: "2.1.263",
            versionVerdict: "ok",
            auth,
            models: [
              {
                slug: "claude-sonnet-5",
                name: "Sonnet 5",
                acceptsImages: true,
                isDefault: true,
                options: [],
              },
              { slug: "claude-opus-5", name: "Opus 5", acceptsImages: true, options: [] },
            ],
          },
        ],
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt: "2026-09-01T09:00:00.000Z",
});

const LOGGED_IN = { status: "ok", identity: "rogier@example.com" } as const;

describe("buildAssistantProviderField", () => {
  it("offers each instance's default model, then its catalog, named after the instance", () => {
    const instances = [
      buildInstance(PERSONAL, "claude-code", "personal", "Claude Code", LOGGED_IN),
    ];

    const field = buildAssistantProviderField(instances, { instanceId: PERSONAL, model: null });

    expect(field.groups).toEqual([
      {
        instanceId: PERSONAL,
        label: "Claude Code",
        choices: [
          { instanceId: PERSONAL, model: null, label: "Claude Code · Default model" },
          { instanceId: PERSONAL, model: "claude-sonnet-5", label: "Claude Code · Sonnet 5" },
          { instanceId: PERSONAL, model: "claude-opus-5", label: "Claude Code · Opus 5" },
        ],
      },
    ]);
    expect(field.providerId).toBe("claude-code");
    expect(field.hint).toBe("rogier@example.com");
  });

  it("names two instances of one provider by their account names", () => {
    const instances = [
      buildInstance(PERSONAL, "claude-code", "personal", "Claude Code", LOGGED_IN),
      buildInstance(WORK, "claude-code", "work", "Claude Code", LOGGED_IN),
    ];

    const field = buildAssistantProviderField(instances, { instanceId: WORK, model: null });

    expect(field.groups.map(({ label }) => label)).toEqual(["personal", "work"]);
  });

  it("offers only the default model of an instance that is not logged in", () => {
    const instances = [
      buildInstance(CODEX, "codex", "codex", "Codex", { status: "unauthenticated" }),
    ];

    const field = buildAssistantProviderField(instances, { instanceId: CODEX, model: null });

    expect(field.groups[0]?.choices).toEqual([
      { instanceId: CODEX, model: null, label: "Codex · Default model" },
    ]);
    expect(field.hint).toBe("Codex");
  });

  it("keeps the assistant's model when the catalog no longer offers it", () => {
    const instances = [
      buildInstance(PERSONAL, "claude-code", "personal", "Claude Code", LOGGED_IN),
    ];

    const field = buildAssistantProviderField(instances, {
      instanceId: PERSONAL,
      model: "claude-sonnet-4",
    });

    expect(field.groups[0]?.choices.at(-1)).toEqual({
      instanceId: PERSONAL,
      model: "claude-sonnet-4",
      label: "Claude Code · claude-sonnet-4",
    });
  });

  it("keeps the assistant's model on an instance that is not logged in", () => {
    const instances = [
      buildInstance(CODEX, "codex", "codex", "Codex", { status: "unauthenticated" }),
    ];

    const field = buildAssistantProviderField(instances, { instanceId: CODEX, model: "gpt-6" });

    expect(field.groups[0]?.choices).toEqual([
      { instanceId: CODEX, model: null, label: "Codex · Default model" },
      { instanceId: CODEX, model: "gpt-6", label: "Codex · gpt-6" },
    ]);
  });

  it("does not add the assistant's model to another instance's group", () => {
    const instances = [
      buildInstance(PERSONAL, "claude-code", "personal", "Claude Code", LOGGED_IN),
      buildInstance(CODEX, "codex", "codex", "Codex", { status: "unauthenticated" }),
    ];

    const field = buildAssistantProviderField(instances, {
      instanceId: PERSONAL,
      model: "claude-sonnet-4",
    });

    expect(field.groups[1]?.choices.map((choice) => choice.model)).toEqual([null]);
  });

  it.each([null, "claude-sonnet-5"])(
    "adds a deleted instance as a last group holding only the assistant's choice, model %s",
    (model) => {
      const instances = [
        buildInstance(PERSONAL, "claude-code", "personal", "Claude Code", LOGGED_IN),
      ];

      const field = buildAssistantProviderField(instances, { instanceId: WORK, model });

      const label = `${toIdTail(WORK)} (not found)`;
      expect(field.groups.at(-1)).toEqual({
        instanceId: WORK,
        label,
        choices: [{ instanceId: WORK, model, label: `${label} · ${model ?? "Default model"}` }],
      });
      expect(field.providerId).toBeNull();
      expect(field.hint).toBe("");
    },
  );
});
