/**
 * Tests that a request with several invalid fields is refused once, with every
 * problem in `details.issues`, as spec 11 ("One error per response") says.
 *
 * Each case sends a real request over a socket, so it covers the decoding the
 * transport does for that part of the request, and nothing is decoded by the
 * test itself.
 */
import { describe, expect, it } from "vitest";
import type { Task } from "@hercule/contract";
import { completeSetup, get, post, send, withServer } from "./testing";

interface Refusal {
  readonly error: {
    readonly code: string;
    readonly details: {
      readonly issues: ReadonlyArray<{ readonly path: ReadonlyArray<string> }>;
    };
  };
}

/** Returns the paths of the issues a refusal reports, each joined with dots. */
const issuePaths = (refusal: Refusal): ReadonlyArray<string> =>
  refusal.error.details.issues.map((issue) => issue.path.join("."));

describe("a refused request reports every problem", () => {
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
      const refusal = (await response.json()) as Refusal;
      expect(refusal.error.code).toBe("validation");
      expect(issuePaths(refusal)).toEqual(expect.arrayContaining(["stage", "priority"]));
    });
  });

  it("reports both invalid parameters of a query string", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);

      const response = await get(base, "/api/v1/tasks?limit=0&status=no-such-status", token);

      expect(response.status).toBe(400);
      const refusal = (await response.json()) as Refusal;
      expect(refusal.error.code).toBe("validation");
      expect(issuePaths(refusal)).toEqual(expect.arrayContaining(["limit", "status.0"]));
    });
  });
});
