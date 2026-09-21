/**
 * What the pi adapter's probe reports about a machine, over a fake pi:
 * nothing vendor-supplied runs. The probe is reached through the adapter,
 * because that is how the runner reaches it.
 *
 * The one-shot commands and their output are pi 0.85.1's own - `pi --version`
 * printing the bare version, `pi auth check --provider zai --json` printing a
 * status object and exiting 1 when no credential is configured.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ProbeResult } from "@hercule/protocol";
import { piAdapter } from "./adapter";
import {
  buildFakePiSeam,
  cleanupHomes,
  contextIn,
  FAKE_PI_VERSION,
  type FakePiBehaviour,
  homing,
  TEST_ZAI_KEY,
} from "./testing";

afterAll(cleanupHomes);

const probing = (
  behaviour: FakePiBehaviour = {},
  secrets: Readonly<Record<string, string>> = { zaiApiKey: TEST_ZAI_KEY },
  // Collected rather than defaulted: a default would take the `undefined` the
  // machine-without-pi case passes for "not given" and hand it a pi anyway.
  ...binary: ReadonlyArray<string | undefined>
): {
  readonly result: Promise<ProbeResult>;
  readonly runs: ReturnType<typeof buildFakePiSeam>["runs"];
  readonly spawns: ReturnType<typeof buildFakePiSeam>["spawns"];
} => {
  const { seam, runs, spawns } = buildFakePiSeam(behaviour);
  const ctx = {
    ...contextIn(homing(), null, secrets),
    ...(binary.length === 0 ? {} : { binary: binary[0] }),
  };
  return { result: Effect.runPromise(piAdapter(seam).probe(ctx, {})), runs, spawns };
};

const optionOf = (
  models: ProbeResult["models"],
  slug: string,
  id: string,
): Record<string, unknown> | undefined =>
  models.find((model) => model.slug === slug)?.options.find((option) => option.id === id);

const valuesOf = (option: Record<string, unknown> | undefined): ReadonlyArray<string> =>
  ((option?.["choices"] ?? []) as ReadonlyArray<{ readonly value: string }>).map(
    (choice) => choice.value,
  );

describe("what the pi adapter reports about a machine", () => {
  it("reports the version the binary itself prints", async () => {
    const { result, runs } = probing();

    const probed = await result;
    expect(probed.harnessVersion).toBe(FAKE_PI_VERSION);
    expect(runs.map((run) => run.command.slice(1))).toContainEqual(["--version"]);
  });

  it("reports a machine whose auth check says ready as logged in, naming nobody", async () => {
    const { result, runs } = probing();

    const probed = await result;
    expect(probed.auth.status).toBe("ok");
    // pi's Z.ai upstream is an API key: there is no account to name, and a
    // made-up identity would be a name the user never entered.
    expect(probed.auth.identity).toBeUndefined();
    expect(probed.auth.message).toBeUndefined();
    expect(runs.map((run) => run.command.slice(1))).toContainEqual([
      "auth",
      "check",
      "--provider",
      "zai",
      "--json",
    ]);
  });

  it("puts the Z.ai key it was given where pi looks for it", async () => {
    const { result, runs } = probing();

    await result;
    const checked = runs.find((run) => run.command.includes("check"));
    expect(checked?.env["ZAI_API_KEY"]).toBe(TEST_ZAI_KEY);
  });

  it("reports a machine with no key as unauthenticated, not as broken", async () => {
    const { result } = probing({}, {});

    const probed = await result;
    // Not `error`: nobody has entered a key yet, and telling that apart from a
    // broken harness is what the Fleet row is read for.
    expect(probed.auth.status).toBe("unauthenticated");
    expect(probed.auth.identity).toBeUndefined();
  });

  it("reports a machine with no pi on it as an error that says so", async () => {
    const { result } = probing({}, { zaiApiKey: TEST_ZAI_KEY }, undefined);

    const probed = await result;
    expect(probed.auth.status).toBe("error");
    expect(probed.auth.message ?? "").not.toBe("");
  });

  it("reports what a failing command said, rather than that something failed", async () => {
    const { result } = probing({
      ran: () => ({ code: 127, stdout: "", stderr: "pi: command not found" }),
    });

    const probed = await result;
    expect(probed.auth.status).toBe("error");
    expect(probed.auth.message).toContain("command not found");
  });

  it("offers the models pi lists for Z.ai, and no other provider's", async () => {
    const { result } = probing();

    const probed = await result;
    expect(probed.models.map((model) => model.slug)).toEqual([
      "glm-4.7",
      "glm-5-turbo",
      "glm-5.2",
      "glm-5.2-highspeed",
      "glm-5.3",
      "glm-5.3-flash",
      "glm-5.3-highspeed",
    ]);
    expect(probed.models.map((model) => model.name)).toEqual([
      "GLM-4.7",
      "GLM-5-Turbo",
      "GLM-5.2",
      "GLM-5.2 Highspeed",
      "GLM-5.3",
      "GLM-5.3-Flash",
      "GLM-5.3 Highspeed",
    ]);
  });

  it("offers only the thinking levels the model maps to something", async () => {
    const { result } = probing();

    const probed = await result;
    // GLM 5.3 maps `off`, `minimal`, `medium` and `xhigh` to null: it cannot be
    // asked for those, and offering one would be a turn Z.ai refuses.
    expect(valuesOf(optionOf(probed.models, "glm-5.3", "thinking"))).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(valuesOf(optionOf(probed.models, "glm-5.3-flash", "thinking"))).toEqual([
      "low",
      "high",
      "max",
    ]);
    // The 5.2 line takes `off` where the 5.3 line cannot, and the two models
    // with no map at all offer no choice rather than an empty one.
    expect(valuesOf(optionOf(probed.models, "glm-5.2", "thinking"))).toEqual([
      "off",
      "high",
      "max",
    ]);
    expect(optionOf(probed.models, "glm-4.7", "thinking")).toBeUndefined();
  });
});
