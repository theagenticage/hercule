/**
 * Tests what the pi adapter's probe reports about a machine, using a fake pi,
 * so no vendor code runs. The tests call the probe through the adapter,
 * because that is how the runner calls it.
 *
 * The one-shot commands and their output match pi 0.85.1: `pi --version`
 * prints the bare version, and `pi auth check --provider zai --json` prints a
 * status object and exits with code 1 when no key is configured.
 */
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { ProbeResult } from "@hercule/protocol";
import { makePiAdapter } from "./adapter";
import {
  buildFakePiSeam,
  cleanupHomes,
  buildContext,
  FAKE_PI_VERSION,
  type FakePiBehaviour,
  createPiHome,
  TEST_ZAI_KEY,
} from "./testing";

afterAll(cleanupHomes);

const runProbe = (
  behaviour: FakePiBehaviour = {},
  secrets: Readonly<Record<string, string>> = { zaiApiKey: TEST_ZAI_KEY },
  // A rest parameter, not a default: a default would replace the explicit
  // `undefined` that the no-pi test passes, and give that test a pi anyway.
  ...binary: ReadonlyArray<string | undefined>
): {
  readonly result: Promise<ProbeResult>;
  readonly runs: ReturnType<typeof buildFakePiSeam>["runs"];
  readonly spawns: ReturnType<typeof buildFakePiSeam>["spawns"];
} => {
  const { seam, runs, spawns } = buildFakePiSeam(behaviour);
  const ctx = {
    ...buildContext(createPiHome(), null, secrets),
    ...(binary.length === 0 ? {} : { binary: binary[0] }),
  };
  return { result: Effect.runPromise(makePiAdapter(seam).probe(ctx, {})), runs, spawns };
};

const findModelOption = (
  models: ProbeResult["models"],
  slug: string,
  id: string,
): Record<string, unknown> | undefined =>
  models.find((model) => model.slug === slug)?.options.find((option) => option.id === id);

const listChoiceValues = (option: Record<string, unknown> | undefined): ReadonlyArray<string> =>
  ((option?.["choices"] ?? []) as ReadonlyArray<{ readonly value: string }>).map(
    (choice) => choice.value,
  );

describe("the pi adapter's probe", () => {
  it("reports the version the binary prints", async () => {
    const { result, runs } = runProbe();

    const probed = await result;
    expect(probed.harnessVersion).toBe(FAKE_PI_VERSION);
    expect(runs.map((run) => run.command.slice(1))).toContainEqual(["--version"]);
  });

  it("reports a ready auth check as logged in, with no identity", async () => {
    const { result, runs } = runProbe();

    const probed = await result;
    expect(probed.auth.status).toBe("ok");
    // Z.ai uses an API key, so there is no account name to report, and a
    // made-up identity would show a name the user never entered.
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

  it("passes the instance's Z.ai key in the environment variable pi reads", async () => {
    const { result, runs } = runProbe();

    await result;
    const checked = runs.find((run) => run.command.includes("check"));
    expect(checked?.env["ZAI_API_KEY"]).toBe(TEST_ZAI_KEY);
  });

  it("reports a machine with no key as unauthenticated, not as broken", async () => {
    const { result } = runProbe({}, {});

    const probed = await result;
    // Not `error`: nobody has entered a key yet. The Fleet row must tell that
    // apart from a broken pi.
    expect(probed.auth.status).toBe("unauthenticated");
    expect(probed.auth.identity).toBeUndefined();
  });

  it("reports an error with a message when pi is not installed", async () => {
    const { result } = runProbe({}, { zaiApiKey: TEST_ZAI_KEY }, undefined);

    const probed = await result;
    expect(probed.auth.status).toBe("error");
    expect(probed.auth.message ?? "").not.toBe("");
  });

  it("reports a failing command's own error output", async () => {
    const { result } = runProbe({
      ran: () => ({ code: 127, stdout: "", stderr: "pi: command not found" }),
    });

    const probed = await result;
    expect(probed.auth.status).toBe("error");
    expect(probed.auth.message).toContain("command not found");
  });

  it("offers the Z.ai models pi lists, and no other provider's", async () => {
    const { result } = runProbe();

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

  it("declares pi's image size limit on the models that take images, and no images on the rest", async () => {
    const { result } = runProbe();

    const probed = await result;
    const imageInputs = Object.fromEntries(
      probed.models.map((model) => [model.slug, model.imageInput]),
    );
    // 3,538,944 bytes is 3.375 MiB, the most that fits in pi's 4.5 MiB of base64.
    expect(imageInputs["glm-5.3-flash"]).toEqual({ maxBytes: 3_538_944 });
    expect(imageInputs["glm-5.3"]).toBeNull();
  });

  it("offers only the thinking levels each model supports", async () => {
    const { result } = runProbe();

    const probed = await result;
    // GLM 5.3 maps `off`, `minimal`, `medium` and `xhigh` to null: it does not
    // support them, and Z.ai would reject a turn at one of those levels.
    expect(listChoiceValues(findModelOption(probed.models, "glm-5.3", "thinking"))).toEqual([
      "low",
      "high",
      "max",
    ]);
    expect(listChoiceValues(findModelOption(probed.models, "glm-5.3-flash", "thinking"))).toEqual([
      "low",
      "high",
      "max",
    ]);
    // The 5.2 models support `off` and the 5.3 models do not. The two models
    // with no thinking map offer no thinking option, not an empty one.
    expect(listChoiceValues(findModelOption(probed.models, "glm-5.2", "thinking"))).toEqual([
      "off",
      "high",
      "max",
    ]);
    expect(findModelOption(probed.models, "glm-4.7", "thinking")).toBeUndefined();
  });
});
