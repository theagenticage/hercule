/**
 * Tests the open Request a session record carries: the request as the harness
 * opened it, and the subagent that asked it, by id and by name. Also tests
 * that every session prompt and input takes text, images, or both, never
 * neither.
 */
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { InputUpdatePayload } from "./input";
import {
  SessionContinueInput,
  SessionInputCall,
  SessionInputPayload,
  SessionRequest,
  SessionSpawnInput,
} from "./session";

const request = {
  requestId: "r-1",
  itemId: "item-1",
  kind: "command_approval",
  decisions: ["allow", "deny"],
  detail: { command: "git push" },
} as const;

const decode = Schema.decodeUnknownSync(SessionRequest);

describe("SessionRequest", () => {
  it("accepts a Request of the session's own agent, which names no subagent", () => {
    expect(decode(request)).toEqual(request);
  });

  it("carries the id and the name of the subagent that asked", () => {
    const asked = { ...request, subagentId: "agent-a1", subagentName: "Read the docs" };
    expect(decode(asked)).toEqual(asked);
  });

  it("accepts a subagent's Request whose subagent has no name yet", () => {
    const asked = { ...request, subagentId: "agent-a1" };
    expect(decode(asked)).toEqual(asked);
  });
});

describe("starting revisions in session.spawn", () => {
  const resourceId = "0199e0e7-1111-7000-8000-000000000002";
  const spawn = (checkout: object) => ({
    prompt: "Continue work",
    workspace: { kind: "ephemeral", checkouts: [{ resourceId, ...checkout }] },
  });

  it("preserves current, named local, named remote and remote-default choices", () => {
    for (const startingRevision of [
      { kind: "current" },
      { kind: "local", branch: "feature/local-only" },
      { kind: "remote", branch: "release/2.1" },
      { kind: "remote" },
    ]) {
      const input = spawn({ startingRevision });
      expect(Schema.decodeUnknownSync(SessionSpawnInput)(input)).toEqual(input);
    }
  });

  it("keeps omitted and deprecated revision inputs valid", () => {
    for (const checkout of [{}, { baseBranch: "release/2.1" }]) {
      const input = spawn(checkout);
      expect(Schema.decodeUnknownSync(SessionSpawnInput)(input)).toEqual(input);
    }
  });

  it("refuses branch options, control characters and invalid Git ref syntax before work starts", () => {
    for (const kind of ["local", "remote"]) {
      for (const branch of [
        "",
        "--upload-pack=id",
        "feature..other",
        "feature\nother",
        "feature\u0000other",
        "feature@{1}",
        "feature.lock",
      ]) {
        expect(
          Schema.decodeUnknownExit(SessionSpawnInput)(spawn({ startingRevision: { kind, branch } }))
            ._tag,
          `${kind}: ${JSON.stringify(branch)}`,
        ).toBe("Failure");
      }
    }
  });

  it("refuses simultaneous deprecated and explicit revision choices", () => {
    for (const startingRevision of [
      { kind: "current" },
      { kind: "local", branch: "main" },
      { kind: "remote", branch: "main" },
      { kind: "remote" },
    ]) {
      expect(
        Schema.decodeUnknownExit(SessionSpawnInput)(spawn({ baseBranch: "main", startingRevision }))
          ._tag,
      ).toBe("Failure");
    }
  });
});

describe("text and images in a session prompt or input", () => {
  const sessionId = "0199e0e7-1111-7000-8000-000000000001";
  const image = "0199e0e7-1111-7000-8000-000000000003";
  const payloads = [
    { name: "session.spawn", schema: SessionSpawnInput, base: {}, field: "prompt" },
    { name: "session.input", schema: SessionInputPayload, base: {}, field: "text" },
    { name: "a bound answer", schema: SessionInputCall, base: { sessionId }, field: "text" },
    {
      name: "session.continue",
      schema: SessionContinueInput,
      base: { mode: "fork" },
      field: "prompt",
    },
  ] as const;

  it.each(payloads)("$name takes text alone, images alone, or both", ({ schema, base, field }) => {
    const decode = Schema.decodeUnknownSync(schema);
    for (const payload of [
      { ...base, [field]: "Look at this" },
      { ...base, [field]: "", attachments: [image] },
      { ...base, [field]: "Look at this", attachments: [image] },
    ])
      expect(decode(payload)).toEqual(payload);
  });

  it.each(payloads)(
    "$name refuses empty text with no images, at the text field",
    ({ schema, base, field }) => {
      const decode = Schema.decodeUnknownExit(schema);
      for (const payload of [
        { ...base, [field]: "" },
        { ...base, [field]: "", attachments: [] },
      ]) {
        const exit = decode(payload);
        expect(exit._tag).toBe("Failure");
        expect(String(exit)).toContain("A prompt needs text or at least one image.");
        expect(String(exit)).toContain(`["${field}"]`);
      }
    },
  );

  it("input.update takes empty text without `attachments`, which keeps the input's images", () => {
    const decode = Schema.decodeUnknownSync(InputUpdatePayload);
    for (const payload of [
      { text: "" },
      { text: "Look at this" },
      { text: "", attachments: [image] },
      { text: "Look at this", attachments: [] },
    ])
      expect(decode(payload)).toEqual(payload);
  });

  it("input.update refuses empty text that removes every image, at the text field", () => {
    const exit = Schema.decodeUnknownExit(InputUpdatePayload)({ text: "", attachments: [] });
    expect(exit._tag).toBe("Failure");
    expect(String(exit)).toContain("A prompt needs text or at least one image.");
    expect(String(exit)).toContain(`["text"]`);
  });

  it("refuses more than ten images on one input", () => {
    const eleven = Array.from({ length: 11 }, () => image);
    expect(
      Schema.decodeUnknownExit(SessionInputPayload)({ text: "", attachments: eleven })._tag,
    ).toBe("Failure");
  });
});
