/**
 * Tests that a request with several invalid fields is refused once, with every
 * problem in `details.issues` (spec 11, "One error per response"). Each case
 * sends a real request over a socket, so the transport does all the decoding.
 */
import { describe, expect, it } from "vitest";
import type { Task } from "@hercule/contract";
import { completeSetup, del, get, post, readErrorBody, send, withServer } from "./testing";

describe("a refused request reports every problem of the part it decodes", () => {
  it("reports both invalid fields of a payload", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const created = await post(base, "/api/v1/tasks", { title: "A", description: "" }, token);
      const task = (await created.json()) as Task;

      const response = await send("PATCH", base, `/api/v1/tasks/${task.id}`, {
        token,
        body: { stage: "no-such-stage", priority: "no-such-priority" },
      });

      expect(response.status).toBe(400);
      const refusal = await readErrorBody(response);
      expect(refusal.code).toBe("validation");
      expect(refusal.issues).toEqual([["stage"], ["priority"]]);
    });
  });

  it("reports both invalid parameters of a query string", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);

      const response = await get(base, "/api/v1/tasks?limit=0&status=no-such-status", token);

      expect(response.status).toBe(400);
      const refusal = await readErrorBody(response);
      expect(refusal.code).toBe("validation");
      expect(refusal.issues).toEqual([["status", "0"], ["limit"]]);
    });
  });

  it("reports both invalid parameters of a path", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);

      const response = await del(base, "/api/v1/tasks/bad/blockers/also-bad", token);

      expect(response.status).toBe(400);
      const refusal = await readErrorBody(response);
      expect(refusal.code).toBe("validation");
      expect(refusal.issues).toEqual([["id"], ["blockedByTaskId"]]);
    });
  });
});
