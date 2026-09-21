/**
 * `controller.read` and `controller.update` over a real socket: the default
 * runner, which is the one thing a caller may write about the controller.
 */
import { describe, expect, it } from "vitest";
import type { Runner } from "@hercule/contract";
import { completeSetup, get, send, withServer } from "../http/testing";

interface ControllerInfo {
  readonly id: string;
  readonly publicKey: string;
  readonly version: string;
  readonly defaultRunnerId: string | null;
}

/** A well-formed id no runner has. */
const UNKNOWN_ID = "0199e0e7-9999-7000-8000-000000000000";

const info = async (base: string, token: string): Promise<ControllerInfo> => {
  const response = await get(base, "/api/v1/controller", token);
  expect(response.status).toBe(200);
  return (await response.json()) as ControllerInfo;
};

const update = (base: string, token: string, body: unknown): Promise<Response> =>
  send("PATCH", base, "/api/v1/controller", { body, token });

describe("the controller's default runner", () => {
  it("is null until one is named, and is the runner named afterwards", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner: Runner = await harness.insertRunner({ name: "iris" });

      const before = await info(harness.base, token);
      expect(before.defaultRunnerId).toBeNull();
      expect(before.id).toEqual(expect.any(String));
      expect(before.publicKey).toEqual(expect.any(String));
      expect(before.version).toEqual(expect.any(String));

      expect((await update(harness.base, token, { defaultRunnerId: runner.id })).status).toBe(200);

      const after = await info(harness.base, token);
      expect(after.defaultRunnerId).toBe(runner.id);
      expect({ id: after.id, publicKey: after.publicKey, version: after.version }).toEqual({
        id: before.id,
        publicKey: before.publicKey,
        version: before.version,
      });
    });
  });

  it("refuses a key it does not declare", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner: Runner = await harness.insertRunner({ name: "iris" });

      const response = await update(harness.base, token, {
        defaultRunnerId: runner.id,
        version: "9.9.9",
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
      expect((await info(harness.base, token)).defaultRunnerId).toBeNull();
    });
  });

  it("refuses a runner nobody has, and leaves the setting where it was", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner: Runner = await harness.insertRunner({ name: "iris" });
      expect((await update(harness.base, token, { defaultRunnerId: runner.id })).status).toBe(200);

      const response = await update(harness.base, token, { defaultRunnerId: UNKNOWN_ID });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });

      expect((await info(harness.base, token)).defaultRunnerId).toBe(runner.id);
    });
  });

  it("takes the default off again, and records each change once", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner: Runner = await harness.insertRunner({ name: "iris" });

      expect((await update(harness.base, token, { defaultRunnerId: runner.id })).status).toBe(200);
      // Naming the same runner again is not a change.
      expect((await update(harness.base, token, { defaultRunnerId: runner.id })).status).toBe(200);
      expect((await update(harness.base, token, { defaultRunnerId: null })).status).toBe(200);

      expect((await info(harness.base, token)).defaultRunnerId).toBeNull();
      const entries = await harness.audit("controller.updated");
      expect(entries).toHaveLength(2);
      expect(entries.every((entry) => entry.actor === "user")).toBe(true);
    });
  });

  it("keeps the default runner out of the settings the settings API carries", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner: Runner = await harness.insertRunner({ name: "iris" });
      expect((await update(harness.base, token, { defaultRunnerId: runner.id })).status).toBe(200);

      const response = await get(harness.base, "/api/v1/settings", token);
      expect(response.status).toBe(200);
      const state = (await response.json()) as { controller: Record<string, unknown> };
      expect(Object.keys(state.controller)).not.toContain("defaultRunnerId");
    });
  });

  it("refuses a reserved runner and a retired one, and leaves the setting where it was", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const open: Runner = await harness.insertRunner({ name: "iris" });
      const personal: Runner = await harness.insertRunner({ name: "atlas", reserved: true });
      const gone: Runner = await harness.insertRunner({ name: "vega", lifecycle: "retired" });
      expect((await update(harness.base, token, { defaultRunnerId: open.id })).status).toBe(200);

      // The default is where work with nothing to say about placement lands,
      // which is exactly what neither of these two takes.
      for (const runner of [personal, gone]) {
        const response = await update(harness.base, token, { defaultRunnerId: runner.id });
        expect(response.status, `${runner.name}: ${await response.clone().text()}`).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "conflict" } });
        expect((await info(harness.base, token)).defaultRunnerId).toBe(open.id);
      }
    });
  });

  it("changes nothing when the patch names no field", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner: Runner = await harness.insertRunner({ name: "iris" });
      expect((await update(harness.base, token, { defaultRunnerId: runner.id })).status).toBe(200);
      const before = await info(harness.base, token);

      expect((await update(harness.base, token, {})).status).toBe(200);

      expect(await info(harness.base, token)).toEqual(before);
    });
  });
});
