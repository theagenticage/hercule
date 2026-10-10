/**
 * The promotion gate classifies a request by its operation, not only by its
 * HTTP method: an operation that changes nothing but takes a body keeps
 * answering while a promotion freezes the controller.
 */
import { describe, expect, it } from "vitest";
import { RUNNER_ATTACHMENTS_PATH } from "@hercule/protocol";
import { freezeController } from "../promotion/testing";
import { completeSetup, post, readErrorBody, send, withServer } from "./testing";

describe("promotion gate", () => {
  it("answers workflow.validate while frozen, and still refuses a write", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      const validate = () =>
        post(harness.base, "/api/v1/workflows/validate", { source: "steps: []" }, user);
      const before = await validate();
      expect(before.status).toBe(200);
      const answered = await before.json();

      await freezeController(harness.base, user);

      const frozen = await validate();
      expect(frozen.status).toBe(200);
      expect(await frozen.json()).toEqual(answered);

      const write = await send(
        "PUT",
        harness.base,
        "/api/v1/secrets/runner/0198e4b0-0000-7000-8000-000000000001/api-token",
        {
          body: { value: "a value" },
          token: user,
        },
      );
      expect(write.status).toBe(409);
      expect((await readErrorBody(write)).code).toBe("promotion_in_progress");
    });
  });

  // An upload writes a file and a row that B would never receive, so a frozen
  // controller refuses it before it even checks the credential.
  it("refuses a runner's image upload while frozen", async () => {
    await withServer(async (harness) => {
      const user = await completeSetup(harness.base);
      await freezeController(harness.base, user);

      const upload = await send("POST", harness.base, `${RUNNER_ATTACHMENTS_PATH}?sessionId=s`);
      expect(upload.status).toBe(409);
      expect((await readErrorBody(upload)).code).toBe("promotion_in_progress");
    });
  });
});
