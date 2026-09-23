import { describe, expect, it } from "vitest";
import {
  ApiError,
  ConnectionError,
  isNotFound,
  readValidationIssues,
  RequestError,
} from "@hercule/client-core";

describe("readValidationIssues", () => {
  const ISSUES = [
    { path: ["steps", "1", "action"], message: "task.creat is not an action." },
    { path: [], message: "3 more problems." },
  ];

  it("returns the issues of a validation error, in order", () => {
    const refusal = new ApiError("validation", "The workflow is not valid.", { issues: ISSUES });
    expect(readValidationIssues(refusal)).toEqual(ISSUES);
  });

  it("returns undefined for any other error", () => {
    expect(readValidationIssues(new ApiError("not_found", "No workflow has that id."))).toBe(
      undefined,
    );
    expect(readValidationIssues(new ApiError("validation", "The request is not valid."))).toBe(
      undefined,
    );
    expect(
      readValidationIssues(new ConnectionError("http://controller.test", new Error("refused"))),
    ).toBe(undefined);
    // A RequestError fails before the request is sent. Its issues are on the
    // error itself, not in a controller response.
    expect(readValidationIssues(new RequestError(ISSUES, new Error("bad input")))).toBe(undefined);
    expect(readValidationIssues(new Error("no"))).toBe(undefined);
  });
});

describe("isNotFound", () => {
  it("returns true only for a not_found response from the controller", () => {
    expect(isNotFound(new ApiError("not_found", "No workflow has that id."))).toBe(true);
    expect(isNotFound(new ApiError("forbidden", "No."))).toBe(false);
    expect(isNotFound(new ConnectionError("http://controller.test", new Error("refused")))).toBe(
      false,
    );
    expect(isNotFound(null)).toBe(false);
  });
});
