/**
 * Tests `buildThreadModelField(account, harnessId, runnerId, current)`, which
 * builds the model field of Settings > Threads: the picked account's models in
 * the harness a thread runs in, from the snapshot of the runner a new thread
 * would be placed on when there is one, else from the account's first
 * snapshot in that harness.
 */
import { describe, expect, it } from "vitest";
import type { ProviderAccount } from "@hercule/contract";
import { buildThreadModelField } from "./model-field";

const HARNESS = "claude-code/claude-code";
const LOCAL = "01a06d02-beff-7037-9f5b-042822015952";
const OTHER = "01a06d02-beff-7037-9f5b-042822015953";

const buildSnapshot = (
  runnerId: string,
  models: ProviderAccount["snapshots"][number]["models"],
): ProviderAccount["snapshots"][number] => ({
  runnerId,
  harnessId: HARNESS,
  probedAt: "2026-09-05T09:14:00.000Z",
  harnessVersion: "2.1.263",
  versionVerdict: "ok",
  auth: { status: "ok", identity: "rogier@example.com", planLabel: "Claude Max" },
  models,
});

const MODELS = [
  { slug: "claude-sonnet-5", name: "Sonnet 5", imageInput: { maxBytes: null }, options: [] },
  {
    slug: "claude-opus-5",
    name: "Opus 5",
    imageInput: { maxBytes: null },
    isDefault: true,
    options: [],
  },
];

describe("buildThreadModelField", () => {
  it("offers the models of the local runner's snapshot when there is one", () => {
    const account: Pick<ProviderAccount, "snapshots"> = {
      snapshots: [
        buildSnapshot(OTHER, [
          { slug: "claude-haiku-5", name: "Haiku 5", imageInput: { maxBytes: null }, options: [] },
        ]),
        buildSnapshot(LOCAL, MODELS),
      ],
    };

    const field = buildThreadModelField(account, HARNESS, LOCAL, "claude-sonnet-5");

    expect(field.dimmed).toBeNull();
    expect(field.options.map((option) => option.slug)).toEqual([
      "claude-sonnet-5",
      "claude-opus-5",
    ]);
    expect(field.options.find((option) => option.slug === "claude-opus-5")?.isDefault).toBe(true);
  });

  it("falls back to the account's first snapshot when none is from the local runner", () => {
    const account: Pick<ProviderAccount, "snapshots"> = {
      snapshots: [buildSnapshot(OTHER, MODELS)],
    };

    const field = buildThreadModelField(account, HARNESS, LOCAL, undefined);

    expect(field.dimmed).toBeNull();
    expect(field.options.map((option) => option.slug)).toEqual([
      "claude-sonnet-5",
      "claude-opus-5",
    ]);
  });

  it("falls back to the first snapshot when no local runner is detected at all", () => {
    const account: Pick<ProviderAccount, "snapshots"> = {
      snapshots: [buildSnapshot(OTHER, MODELS)],
    };

    const field = buildThreadModelField(account, HARNESS, null, undefined);

    expect(field.options.map((option) => option.slug)).toEqual([
      "claude-sonnet-5",
      "claude-opus-5",
    ]);
  });

  it("is dimmed with no options when the account has no snapshot", () => {
    const account: Pick<ProviderAccount, "snapshots"> = { snapshots: [] };

    const field = buildThreadModelField(account, HARNESS, LOCAL, "claude-sonnet-5");

    expect(field.dimmed).toBe("sign in on a runner first");
    expect(field.options).toEqual([]);
  });

  it("ignores the snapshots of another harness", () => {
    const account: Pick<ProviderAccount, "snapshots"> = {
      snapshots: [{ ...buildSnapshot(LOCAL, MODELS), harnessId: "pi/pi" }],
    };

    const field = buildThreadModelField(account, HARNESS, LOCAL, undefined);

    expect(field.dimmed).toBe("sign in on a runner first");
  });

  it("is dimmed when the snapshot exists but is not signed in", () => {
    const account: Pick<ProviderAccount, "snapshots"> = {
      snapshots: [{ ...buildSnapshot(LOCAL, MODELS), auth: { status: "unauthenticated" } }],
    };

    const field = buildThreadModelField(account, HARNESS, LOCAL, undefined);

    expect(field.dimmed).toBe("sign in on a runner first");
    expect(field.options).toEqual([]);
  });

  it("keeps a stored slug the snapshot does not offer, marked as missing", () => {
    const account: Pick<ProviderAccount, "snapshots"> = {
      snapshots: [buildSnapshot(LOCAL, MODELS)],
    };

    const field = buildThreadModelField(account, HARNESS, LOCAL, "some-retired-slug");

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
    const account: Pick<ProviderAccount, "snapshots"> = {
      snapshots: [buildSnapshot(LOCAL, MODELS)],
    };

    expect(buildThreadModelField(account, HARNESS, LOCAL, undefined).options).toHaveLength(2);
    expect(buildThreadModelField(account, HARNESS, LOCAL, "claude-sonnet-5").options).toHaveLength(
      2,
    );
  });
});
