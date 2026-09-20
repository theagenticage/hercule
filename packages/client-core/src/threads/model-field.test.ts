/**
 * `threadModelField(instance, localRunnerId, current)` reads Settings >
 * Threads' model field: the picked instance's models, from the local runner's
 * snapshot when it has one, else the instance's first snapshot.
 */
import { describe, expect, it } from "vitest";
import type { ProviderInstance } from "@hercule/contract";
import { threadModelField } from "./model-field";

const LOCAL = "01a06d02-beff-7037-9f5b-042822015952";
const OTHER = "01a06d02-beff-7037-9f5b-042822015953";

const snapshot = (
  runnerId: string,
  models: ProviderInstance["snapshots"][number]["models"],
): ProviderInstance["snapshots"][number] => ({
  runnerId,
  probedAt: "2026-09-05T09:14:00.000Z",
  harnessVersion: "2.1.263",
  versionVerdict: "ok",
  auth: { status: "ok", identity: "rogier@example.com", planLabel: "Claude Max" },
  models,
});

const MODELS = [
  { slug: "claude-sonnet-5", name: "Sonnet 5", options: [] },
  { slug: "claude-opus-5", name: "Opus 5", isDefault: true, options: [] },
];

describe("threadModelField", () => {
  it("offers the local runner's snapshot when it has one", () => {
    const instance: Pick<ProviderInstance, "snapshots"> = {
      snapshots: [
        snapshot(OTHER, [{ slug: "claude-haiku-5", name: "Haiku 5", options: [] }]),
        snapshot(LOCAL, MODELS),
      ],
    };

    const field = threadModelField(instance, LOCAL, "claude-sonnet-5");

    expect(field.dimmed).toBeNull();
    expect(field.options.map((option) => option.slug)).toEqual([
      "claude-sonnet-5",
      "claude-opus-5",
    ]);
    expect(field.options.find((option) => option.slug === "claude-opus-5")?.isDefault).toBe(true);
  });

  it("falls back to the instance's first snapshot when none is the local runner's", () => {
    const instance: Pick<ProviderInstance, "snapshots"> = { snapshots: [snapshot(OTHER, MODELS)] };

    const field = threadModelField(instance, LOCAL, undefined);

    expect(field.dimmed).toBeNull();
    expect(field.options.map((option) => option.slug)).toEqual([
      "claude-sonnet-5",
      "claude-opus-5",
    ]);
  });

  it("falls back to the first snapshot when no local runner is detected at all", () => {
    const instance: Pick<ProviderInstance, "snapshots"> = { snapshots: [snapshot(OTHER, MODELS)] };

    const field = threadModelField(instance, null, undefined);

    expect(field.options.map((option) => option.slug)).toEqual([
      "claude-sonnet-5",
      "claude-opus-5",
    ]);
  });

  it("is dimmed with no options when the instance carries no snapshot at all", () => {
    const instance: Pick<ProviderInstance, "snapshots"> = { snapshots: [] };

    const field = threadModelField(instance, LOCAL, "claude-sonnet-5");

    expect(field.dimmed).toBe("log in on a runner first");
    expect(field.options).toEqual([]);
  });

  it("is dimmed when the snapshot exists but the probe found no login", () => {
    const instance: Pick<ProviderInstance, "snapshots"> = {
      snapshots: [{ ...snapshot(LOCAL, MODELS), auth: { status: "unauthenticated" } }],
    };

    const field = threadModelField(instance, LOCAL, undefined);

    expect(field.dimmed).toBe("log in on a runner first");
    expect(field.options).toEqual([]);
  });

  it("keeps a stored slug the snapshot does not offer, marked as missing", () => {
    const instance: Pick<ProviderInstance, "snapshots"> = { snapshots: [snapshot(LOCAL, MODELS)] };

    const field = threadModelField(instance, LOCAL, "some-retired-slug");

    const retired = field.options.find((option) => option.slug === "some-retired-slug");
    expect(retired).toEqual({
      slug: "some-retired-slug",
      name: "some-retired-slug",
      isDefault: false,
      missing: true,
    });
    expect(field.options).toHaveLength(3);
  });

  it("adds nothing extra when the stored slug is unset or already offered", () => {
    const instance: Pick<ProviderInstance, "snapshots"> = { snapshots: [snapshot(LOCAL, MODELS)] };

    expect(threadModelField(instance, LOCAL, undefined).options).toHaveLength(2);
    expect(threadModelField(instance, LOCAL, "claude-sonnet-5").options).toHaveLength(2);
  });
});
