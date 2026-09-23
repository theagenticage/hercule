import { describe, expect, it } from "vitest";
import { Cause, Schema } from "effect";
import * as HttpServerError from "effect/unstable/http/HttpServerError";
import type * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import { HttpApiSchemaError } from "effect/unstable/httpapi/HttpApiError";
import { createForbiddenError, createNotFoundError } from "@hercule/contract";
import { findApiError, buildErrorResponse } from "./envelope";

const createSchemaError = (kind: HttpApiSchemaError["kind"], input: unknown) => {
  const result = Schema.decodeUnknownExit(
    Schema.Struct({ username: Schema.NonEmptyString, timezone: Schema.NonEmptyString }),
  )(input, { errors: "all" });
  if (result._tag !== "Failure") throw new Error("the fixture is supposed to fail decoding");
  const cause = result.cause.reasons[0];
  if (cause?._tag !== "Fail") throw new Error("the fixture is supposed to fail, not die");
  return new HttpApiSchemaError({ kind, cause: cause.error });
};

const request = { method: "GET", url: "/nope" } as never;

const parseResponseBody = (response: HttpServerResponse.HttpServerResponse): unknown => {
  const body = "body" in response.body ? response.body.body : undefined;
  return JSON.parse(typeof body === "string" ? body : new TextDecoder().decode(body as Uint8Array));
};

describe("findApiError", () => {
  it("turns a payload that will not decode into validation, one issue per field", () => {
    const error = findApiError(Cause.die(createSchemaError("Payload", { username: "" })));

    expect(error?.error.code).toBe("validation");
    expect(error?.error.message).toBe("the request body is not valid");
    const details = (error as { error: { details: { issues: ReadonlyArray<unknown> } } }).error
      .details;
    expect(details.issues).toHaveLength(2);
    expect(details.issues[0]).toMatchObject({ path: ["username"] });
    expect(details.issues[1]).toEqual({ path: ["timezone"], message: "Missing key" });
  });

  it("names the part of the request that was wrong", () => {
    expect(findApiError(Cause.die(createSchemaError("Query", {})))?.error.message).toBe(
      "the query string is not valid",
    );
    expect(findApiError(Cause.die(createSchemaError("Params", {})))?.error.message).toBe(
      "the path is not valid",
    );
  });

  it("says nothing about a schema library", () => {
    const body = JSON.stringify(findApiError(Cause.die(createSchemaError("Payload", {}))));
    expect(body.toLowerCase()).not.toContain("schema");
    expect(body.toLowerCase()).not.toContain("effect");
  });

  it("calls a response the controller cannot encode its own bug, not the caller's", () => {
    expect(findApiError(Cause.die(createSchemaError("Body", {})))?.error.code).toBe("internal");
  });

  it("answers a path no route matched with not_found", () => {
    const cause = Cause.fail(
      new HttpServerError.HttpServerError({
        reason: new HttpServerError.RouteNotFound({ request }),
      }),
    );
    expect(findApiError(cause)?.error.code).toBe("not_found");
  });

  it("keeps the detail of an internal off the wire", () => {
    const error = findApiError(Cause.die(new Error("the disk is on fire")));
    expect(error?.error.code).toBe("internal");
    expect(JSON.stringify(error)).not.toContain("disk");
  });

  it("leaves an interrupted request alone, so a client that hung up is not a 500", () => {
    expect(findApiError(Cause.interrupt())).toBeUndefined();
  });
});

describe("buildErrorResponse", () => {
  it("derives the status from the code and puts nothing beside the envelope", () => {
    const response = buildErrorResponse(createForbiddenError("secret.write"));
    expect(response.status).toBe(403);
    expect(parseResponseBody(response)).toEqual({
      error: {
        code: "forbidden",
        message: "missing grant secret.write",
        details: { grant: "secret.write" },
      },
    });
  });

  it("uses the code's status for every code", () => {
    expect(buildErrorResponse(createNotFoundError("no such profile")).status).toBe(404);
  });
});
