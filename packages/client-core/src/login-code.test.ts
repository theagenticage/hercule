import { describe, expect, it } from "vitest";
import { ApiError, ConnectionError, isLoginCodeRejected } from "@hercule/client-core";

describe("isLoginCodeRejected", () => {
  it("returns true for a validation error whose issue points at the code", () => {
    const refusal = new ApiError("validation", "The login code was not accepted.", {
      issues: [{ path: ["code"], message: "that code was rejected" }],
    });
    expect(isLoginCodeRejected(refusal)).toBe(true);
  });

  it("returns false for a validation error about another field", () => {
    const refusal = new ApiError("validation", "The request is not valid.", {
      issues: [{ path: ["runnerId"], message: "is missing" }],
    });
    expect(isLoginCodeRejected(refusal)).toBe(false);
  });

  it("returns false for an error that says nothing about the code", () => {
    expect(isLoginCodeRejected(new ApiError("invalid_state", "The runner is offline."))).toBe(
      false,
    );
    expect(
      isLoginCodeRejected(new ConnectionError("http://controller.test", new Error("refused"))),
    ).toBe(false);
    expect(isLoginCodeRejected(new Error("no"))).toBe(false);
  });
});
