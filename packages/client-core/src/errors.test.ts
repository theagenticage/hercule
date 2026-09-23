/**
 * What a failure says: the issues of a refusal, which the web app marks in a
 * form or a text and the CLI prints one line each, and whether the record
 * asked for is not there.
 */
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

  it("answers the issues that a validation refusal names, in their order", () => {
    const refusal = new ApiError("validation", "The workflow is not valid.", { issues: ISSUES });
    expect(readValidationIssues(refusal)).toEqual(ISSUES);
  });

  it("answers nothing for a failure that names no problem of what was sent", () => {
    expect(readValidationIssues(new ApiError("not_found", "No workflow has that id."))).toBe(
      undefined,
    );
    expect(readValidationIssues(new ApiError("validation", "The request is not valid."))).toBe(
      undefined,
    );
    expect(
      readValidationIssues(new ConnectionError("http://controller.test", new Error("refused"))),
    ).toBe(undefined);
    // A request that never left names its issues on the error itself.
    expect(readValidationIssues(new RequestError(ISSUES, new Error("bad input")))).toBe(undefined);
    expect(readValidationIssues(new Error("no"))).toBe(undefined);
  });
});

describe("isNotFound", () => {
  it("is true only of the controller's answer that the record is not there", () => {
    expect(isNotFound(new ApiError("not_found", "No workflow has that id."))).toBe(true);
    expect(isNotFound(new ApiError("forbidden", "No."))).toBe(false);
    expect(isNotFound(new ConnectionError("http://controller.test", new Error("refused")))).toBe(
      false,
    );
    expect(isNotFound(null)).toBe(false);
  });
});
