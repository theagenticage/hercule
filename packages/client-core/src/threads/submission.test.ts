/**
 * Tests `buildSubmission(thread, picks, message)`, which builds the request the
 * composer sends: a spawn for a draft thread and an input for an active one,
 * each tagged with its kind. For an active thread, what matters is what it
 * leaves out: a session's access mode and runner are fixed, so an input has
 * the text and only the picks the user actually made.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@hercule/contract";
import { addFilesToShelf, markShelfItemUploaded } from "../attachments/shelf";
import { buildSubmission } from "./submission";

const CONFIG = {
  instanceId: "instance-claude-code",
  model: "claude-sonnet-5",
  accessMode: "approval-required" as const,
  runnerId: "r-local",
  profileId: "p-unrestricted",
  options: { effort: "low" },
};

const SESSION: Session = {
  id: "s1",
  title: "Fix the login bug",
  status: "idle",
  resumable: false,
  resumeHeld: false,
  permissionProfileId: "p-unrestricted",
  agentId: null,
  conversationId: null,
  runId: null,
  stepId: null,
  instanceId: "instance-claude-code",
  runnerId: "r-local",
  workspaceId: null,
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  openRequests: [],
  createdAt: "2026-09-08T09:00:00.000Z",
  startedAt: "2026-09-08T09:00:01.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-08T09:05:00.000Z",
  unenforced: [],
};

const DRAFT = { kind: "draft" as const, config: CONFIG };
const ACTIVE = { kind: "active" as const, session: SESSION };
const MESSAGE = { text: "ship it", attachments: [] };

describe("buildSubmission: a draft thread", () => {
  it("spawns with the draft's config, no workspace and the config's profile", () => {
    expect(buildSubmission(DRAFT, {}, MESSAGE)).toEqual({
      kind: "spawn",
      input: {
        prompt: "ship it",
        instanceId: "instance-claude-code",
        model: "claude-sonnet-5",
        options: { effort: "low" },
        accessMode: "approval-required",
        runnerId: "r-local",
        permissionProfileId: "p-unrestricted",
      },
    });
  });

  it("applies the picks made since the draft was built", () => {
    expect(
      buildSubmission(
        DRAFT,
        { model: "claude-opus-5", options: {}, accessMode: "full-access", runnerId: "r-remote" },
        MESSAGE,
      ),
    ).toEqual({
      kind: "spawn",
      input: {
        prompt: "ship it",
        instanceId: "instance-claude-code",
        model: "claude-opus-5",
        options: {},
        accessMode: "full-access",
        runnerId: "r-remote",
        permissionProfileId: "p-unrestricted",
      },
    });
  });
});

describe("buildSubmission: an active thread", () => {
  it("sends the text alone when nothing was picked", () => {
    expect(buildSubmission(ACTIVE, {}, MESSAGE)).toEqual({
      kind: "input",
      sessionId: SESSION.id,
      payload: { text: "ship it" },
    });
  });

  it("sends a picked model with the text", () => {
    expect(buildSubmission(ACTIVE, { model: "claude-opus-5" }, MESSAGE)).toEqual({
      kind: "input",
      sessionId: SESSION.id,
      payload: { text: "ship it", model: "claude-opus-5" },
    });
  });

  it("sends picked options with the text", () => {
    expect(buildSubmission(ACTIVE, { options: { effort: "high" } }, MESSAGE)).toEqual({
      kind: "input",
      sessionId: SESSION.id,
      payload: { text: "ship it", options: { effort: "high" } },
    });
  });

  it("sends both when both were picked", () => {
    expect(
      buildSubmission(ACTIVE, { model: "claude-opus-5", options: { effort: "high" } }, MESSAGE),
    ).toEqual({
      kind: "input",
      sessionId: SESSION.id,
      payload: { text: "ship it", model: "claude-opus-5", options: { effort: "high" } },
    });
  });

  it("sends no other key, whatever else the picks hold", () => {
    expect(
      buildSubmission(ACTIVE, { accessMode: "full-access", runnerId: "r-remote" }, MESSAGE),
    ).toEqual({ kind: "input", sessionId: SESSION.id, payload: { text: "ship it" } });
  });
});

/**
 * The project and the workspace are sent with the spawn (#72).
 *
 * The composer holds `ThreadConfig.projectId` and `ThreadConfig.workspace`
 * (see `composer-fields.test.ts` for the types). `workspace` is the
 * contract's `SpawnWorkspace`, plus `{ kind: "none" }` for a thread with no
 * checkout, and `null` for a draft with no workspace chosen yet. Neither of
 * those two is a valid `session.spawn` value, so neither is sent: the
 * contract expresses a thread with no checkout by leaving `workspace` out.
 */
const IN_PROJECT = {
  ...CONFIG,
  projectId: "p-webshop",
  preferredWorkspace: null,
  workspace: { kind: "primary" as const, resourceId: "res-webshop" },
};

describe("buildSubmission: the project and the workspace", () => {
  it("sends the project and the main workspace the draft works in", () => {
    expect(buildSubmission({ kind: "draft", config: IN_PROJECT }, {}, MESSAGE)).toEqual({
      kind: "spawn",
      input: {
        prompt: "ship it",
        instanceId: "instance-claude-code",
        model: "claude-sonnet-5",
        options: { effort: "low" },
        accessMode: "approval-required",
        runnerId: "r-local",
        permissionProfileId: "p-unrestricted",
        projectId: "p-webshop",
        workspace: { kind: "primary", resourceId: "res-webshop" },
      },
    });
  });

  it("leaves the actual shared branch unchanged despite an old saved branch pick", () => {
    const input = buildSubmission(
      {
        kind: "draft",
        config: {
          ...IN_PROJECT,
          workspace: { kind: "primary", resourceId: "res-webshop", branch: "release/2.4" },
        },
      },
      {},
      MESSAGE,
    );

    expect(input).toMatchObject({
      input: {
        workspace: { kind: "primary", resourceId: "res-webshop" },
      },
    });
    expect(input.kind === "spawn" && input.input.workspace).not.toHaveProperty("branch");
  });

  it("sends one checkout per repo, with each one's base branch", () => {
    const input = buildSubmission(
      {
        kind: "draft",
        config: {
          ...IN_PROJECT,
          projectId: "p-ops",
          workspace: {
            kind: "ephemeral",
            checkouts: [
              { resourceId: "res-infra", baseBranch: "master" },
              { resourceId: "res-runbooks" },
            ],
          },
        },
      },
      {},
      MESSAGE,
    );

    expect(input).toMatchObject({
      input: {
        projectId: "p-ops",
        workspace: {
          kind: "ephemeral",
          checkouts: [
            { resourceId: "res-infra", baseBranch: "master" },
            { resourceId: "res-runbooks" },
          ],
        },
      },
    });
  });

  it("sends the workspace a thread joins", () => {
    expect(
      buildSubmission(
        {
          kind: "draft",
          config: { ...IN_PROJECT, workspace: { kind: "existing", workspaceId: "ws-thread-3f1" } },
        },
        {},
        MESSAGE,
      ),
    ).toMatchObject({ input: { workspace: { kind: "existing", workspaceId: "ws-thread-3f1" } } });
  });

  it("sends no workspace at all for a thread that works without a checkout", () => {
    const sent = buildSubmission(
      { kind: "draft", config: { ...IN_PROJECT, workspace: { kind: "none" } } },
      {},
      MESSAGE,
    );

    expect(sent.kind).toBe("spawn");
    const input = (sent as { input: Record<string, unknown> }).input;
    expect(input.workspace).toBeUndefined();
    expect(input.projectId).toBe("p-webshop");
  });

  it("sends neither key for a draft with no project and no workspace", () => {
    const sent = buildSubmission(
      { kind: "draft", config: { ...IN_PROJECT, projectId: null, workspace: null } },
      {},
      MESSAGE,
    );

    const input = (sent as { input: Record<string, unknown> }).input;
    expect(input.projectId).toBeUndefined();
    expect(input.workspace).toBeUndefined();
  });

  it("applies a workspace picked since the draft was built", () => {
    expect(
      buildSubmission(
        { kind: "draft", config: IN_PROJECT },
        { workspace: { kind: "ephemeral", checkouts: [{ resourceId: "res-webshop" }] } },
        MESSAGE,
      ),
    ).toMatchObject({
      input: { workspace: { kind: "ephemeral", checkouts: [{ resourceId: "res-webshop" }] } },
    });
  });

  it("sends no workspace for an active thread, whose placement is fixed", () => {
    expect(
      buildSubmission(ACTIVE, { workspace: { kind: "none" }, projectId: "p-webshop" }, MESSAGE),
    ).toEqual({ kind: "input", sessionId: SESSION.id, payload: { text: "ship it" } });
  });
});

describe("buildSubmission: images", () => {
  // Two images on the shelf: the first uploaded, the second still uploading.
  const { shelf } = addFilesToShelf(
    [],
    ["one.png", "two.png"].map((name) =>
      Object.assign(new Blob([new Uint8Array(4)], { type: "image/png" }), { name }),
    ),
    { acceptsImages: true, modelName: "Claude Sonnet 5" },
  );
  const attachments = markShelfItemUploaded(shelf, shelf[0]!.key, {
    id: "att-1",
    name: "one.png",
    mimeType: "image/png",
    sizeBytes: 4,
  });

  it("sends the ids of the uploaded images, with or without text", () => {
    expect(buildSubmission(ACTIVE, {}, { text: "", attachments })).toEqual({
      kind: "input",
      sessionId: SESSION.id,
      payload: { text: "", attachments: ["att-1"] },
    });
    expect(buildSubmission(DRAFT, {}, { text: "look", attachments }).input).toMatchObject({
      prompt: "look",
      attachments: ["att-1"],
    });
  });
});
