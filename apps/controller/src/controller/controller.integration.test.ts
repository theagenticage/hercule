/**
 * Tests `controller.read` and `controller.update` over a real socket: the
 * default runner, which is the one field a caller may change, and the local
 * runner, which no caller can.
 */
import { describe, expect, it } from "vitest";
import type { ControllerInfo, Runner } from "@hercule/contract";
import { completeSetup, get, send, withServer } from "../http/testing";

/** A well-formed id no runner has. */
const UNKNOWN_ID = "0199e0e7-9999-7000-8000-000000000000";

const readControllerInfo = async (base: string, token: string): Promise<ControllerInfo> => {
  const response = await get(base, "/api/v1/controller", token);
  expect(response.status).toBe(200);
  return (await response.json()) as ControllerInfo;
};

const updateController = (base: string, token: string, body: unknown): Promise<Response> =>
  send("PATCH", base, "/api/v1/controller", { body, token });

describe("the controller's default runner", () => {
  it("is null until one is set, and is the chosen runner afterwards", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner: Runner = await harness.insertRunner({ name: "iris" });

      const before = await readControllerInfo(harness.base, token);
      expect(before.defaultRunnerId).toBeNull();
      expect(before.id).toEqual(expect.any(String));
      expect(before.publicKey).toEqual(expect.any(String));
      expect(before.version).toEqual(expect.any(String));

      expect(
        (await updateController(harness.base, token, { defaultRunnerId: runner.id })).status,
      ).toBe(200);

      const after = await readControllerInfo(harness.base, token);
      expect(after.defaultRunnerId).toBe(runner.id);
      expect({ id: after.id, publicKey: after.publicKey, version: after.version }).toEqual({
        id: before.id,
        publicKey: before.publicKey,
        version: before.version,
      });
    });
  });

  it("rejects a field it does not declare", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner: Runner = await harness.insertRunner({ name: "iris" });

      const response = await updateController(harness.base, token, {
        defaultRunnerId: runner.id,
        version: "9.9.9",
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
      expect((await readControllerInfo(harness.base, token)).defaultRunnerId).toBeNull();
    });
  });

  it("rejects an unknown runner, and leaves the setting unchanged", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner: Runner = await harness.insertRunner({ name: "iris" });
      expect(
        (await updateController(harness.base, token, { defaultRunnerId: runner.id })).status,
      ).toBe(200);

      const response = await updateController(harness.base, token, { defaultRunnerId: UNKNOWN_ID });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });

      expect((await readControllerInfo(harness.base, token)).defaultRunnerId).toBe(runner.id);
    });
  });

  it("clears the default again, and records each change once", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner: Runner = await harness.insertRunner({ name: "iris" });

      expect(
        (await updateController(harness.base, token, { defaultRunnerId: runner.id })).status,
      ).toBe(200);
      // Choosing the same runner again is not a change.
      expect(
        (await updateController(harness.base, token, { defaultRunnerId: runner.id })).status,
      ).toBe(200);
      expect((await updateController(harness.base, token, { defaultRunnerId: null })).status).toBe(
        200,
      );

      expect((await readControllerInfo(harness.base, token)).defaultRunnerId).toBeNull();
      const entries = await harness.audit("controller.updated");
      expect(entries).toHaveLength(2);
      expect(entries.every((entry) => entry.actor === "user")).toBe(true);
    });
  });

  it("keeps the default runner out of the settings API", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner: Runner = await harness.insertRunner({ name: "iris" });
      expect(
        (await updateController(harness.base, token, { defaultRunnerId: runner.id })).status,
      ).toBe(200);

      const response = await get(harness.base, "/api/v1/settings", token);
      expect(response.status).toBe(200);
      const state = (await response.json()) as { controller: Record<string, unknown> };
      expect(Object.keys(state.controller)).not.toContain("defaultRunnerId");
    });
  });

  it("rejects a reserved runner and a retired one, and leaves the setting unchanged", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const open: Runner = await harness.insertRunner({ name: "iris" });
      const personal: Runner = await harness.insertRunner({ name: "atlas", reserved: true });
      const gone: Runner = await harness.insertRunner({ name: "vega", lifecycle: "retired" });
      expect(
        (await updateController(harness.base, token, { defaultRunnerId: open.id })).status,
      ).toBe(200);

      // Work with no placement preference runs on the default runner, and
      // neither of these two runners accepts such work.
      for (const runner of [personal, gone]) {
        const response = await updateController(harness.base, token, {
          defaultRunnerId: runner.id,
        });
        expect(response.status, `${runner.name}: ${await response.clone().text()}`).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "conflict" } });
        expect((await readControllerInfo(harness.base, token)).defaultRunnerId).toBe(open.id);
      }
    });
  });

  it("changes nothing when the patch has no fields", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);
      const runner: Runner = await harness.insertRunner({ name: "iris" });
      expect(
        (await updateController(harness.base, token, { defaultRunnerId: runner.id })).status,
      ).toBe(200);
      const before = await readControllerInfo(harness.base, token);

      expect((await updateController(harness.base, token, {})).status).toBe(200);

      expect(await readControllerInfo(harness.base, token)).toEqual(before);
    });
  });
});

describe("the controller's local runner", () => {
  it("is null when the controller starts no local runner", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);

      expect((await readControllerInfo(harness.base, token)).localRunnerId).toBeNull();
    });
  });

  it("is the id the local runner reported", async () => {
    const localRunnerId = "0199e0e7-4444-7000-8000-000000000000";
    await withServer(
      async (harness) => {
        const token = await completeSetup(harness.base);

        expect((await readControllerInfo(harness.base, token)).localRunnerId).toBe(localRunnerId);
      },
      { localRunnerId },
    );
  });

  it("cannot be set, because the controller only reads it from its child", async () => {
    await withServer(async (harness) => {
      const token = await completeSetup(harness.base);

      const response = await updateController(harness.base, token, { localRunnerId: UNKNOWN_ID });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
      expect((await readControllerInfo(harness.base, token)).localRunnerId).toBeNull();
    });
  });
});
