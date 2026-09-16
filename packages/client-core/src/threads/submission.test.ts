/**
 * `submission(thread, picks, message)` is what the composer hands the system
 * on send: a spawn on a draft thread, one input on an active one, each tagged
 * with which it is. What matters on the active side is what it leaves out - a
 * session's access mode and machine are fixed, so an input carries the text
 * and only the picks the user actually made.
 */
import { describe, expect, it } from "vitest";
import type { Session } from "@hydra/contract";
import { submission } from "./submission";

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
  permissionProfileId: "p-unrestricted",
  instanceId: "instance-claude-code",
  runnerId: "r-local",
  workspaceId: null,
  projectId: null,
  requestedAccessMode: "approval-required",
  accessMode: "approval-required",
  nativeSessionId: null,
  modelSelection: { model: "claude-sonnet-5", options: {} },
  parentSessionId: null,
  openRequest: null,
  createdAt: "2026-09-08T09:00:00.000Z",
  startedAt: "2026-09-08T09:00:01.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-08T09:05:00.000Z",
};

const DRAFT = { kind: "draft" as const, config: CONFIG };
const ACTIVE = { kind: "active" as const, session: SESSION };
const MESSAGE = { text: "ship it" };

describe("submission: a draft thread", () => {
  it("spawns with the draft's config, no workspace and the config's profile", () => {
    expect(submission(DRAFT, {}, MESSAGE)).toEqual({
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

  it("overlays the picks made since the draft was built", () => {
    expect(
      submission(
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

describe("submission: an active thread", () => {
  it("sends the text alone when nothing was picked", () => {
    expect(submission(ACTIVE, {}, MESSAGE)).toEqual({
      kind: "input",
      sessionId: SESSION.id,
      payload: { text: "ship it" },
    });
  });

  it("sends a picked model with the text", () => {
    expect(submission(ACTIVE, { model: "claude-opus-5" }, MESSAGE)).toEqual({
      kind: "input",
      sessionId: SESSION.id,
      payload: { text: "ship it", model: "claude-opus-5" },
    });
  });

  it("sends picked options with the text", () => {
    expect(submission(ACTIVE, { options: { effort: "high" } }, MESSAGE)).toEqual({
      kind: "input",
      sessionId: SESSION.id,
      payload: { text: "ship it", options: { effort: "high" } },
    });
  });

  it("sends both when both were picked", () => {
    expect(
      submission(ACTIVE, { model: "claude-opus-5", options: { effort: "high" } }, MESSAGE),
    ).toEqual({
      kind: "input",
      sessionId: SESSION.id,
      payload: { text: "ship it", model: "claude-opus-5", options: { effort: "high" } },
    });
  });

  it("carries no other key, whatever else the picks hold", () => {
    expect(
      submission(ACTIVE, { accessMode: "full-access", runnerId: "r-remote" }, MESSAGE),
    ).toEqual({ kind: "input", sessionId: SESSION.id, payload: { text: "ship it" } });
  });
});

/**
 * Slice 3 of #72 (AC-17): the project and the workspace ride the spawn.
 *
 * `ThreadConfig.projectId` and `ThreadConfig.workspace` are what the composer
 * holds (see `composer-fields.test.ts` for the shapes): `workspace` is the
 * contract's own `SpawnWorkspace` plus `{ kind: "none" }` for a thread with no
 * checkout, and `null` for a draft that has not resolved one. Neither of those
 * two is a `session.spawn` field, so neither is sent - the contract spells a
 * thread with no checkout by leaving `workspace` off.
 */
const IN_PROJECT = {
  ...CONFIG,
  projectId: "p-webshop",
  preferredWorkspace: null,
  workspace: { kind: "primary" as const, resourceId: "res-webshop" },
};

describe("submission: the project and the workspace (AC-17)", () => {
  it("carries the project and the main workspace the draft works in", () => {
    expect(submission({ kind: "draft", config: IN_PROJECT }, {}, MESSAGE)).toEqual({
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

  it("carries the branch the main workspace is to be switched to", () => {
    const input = submission(
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
        workspace: { kind: "primary", resourceId: "res-webshop", branch: "release/2.4" },
      },
    });
  });

  it("carries one checkout per repo, with the base branch each starts from", () => {
    const input = submission(
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

  it("carries the workspace a thread joins", () => {
    expect(
      submission(
        {
          kind: "draft",
          config: { ...IN_PROJECT, workspace: { kind: "existing", workspaceId: "ws-run-3f1" } },
        },
        {},
        MESSAGE,
      ),
    ).toMatchObject({ input: { workspace: { kind: "existing", workspaceId: "ws-run-3f1" } } });
  });

  it("sends no workspace at all for a thread that works without a checkout", () => {
    const sent = submission(
      { kind: "draft", config: { ...IN_PROJECT, workspace: { kind: "none" } } },
      {},
      MESSAGE,
    );

    expect(sent.kind).toBe("spawn");
    const input = (sent as { input: Record<string, unknown> }).input;
    expect(input.workspace).toBeUndefined();
    expect(input.projectId).toBe("p-webshop");
  });

  it("sends neither key for a draft in no project that has resolved no workspace", () => {
    const sent = submission(
      { kind: "draft", config: { ...IN_PROJECT, projectId: null, workspace: null } },
      {},
      MESSAGE,
    );

    const input = (sent as { input: Record<string, unknown> }).input;
    expect(input.projectId).toBeUndefined();
    expect(input.workspace).toBeUndefined();
  });

  it("overlays a workspace picked since the draft was built", () => {
    expect(
      submission(
        { kind: "draft", config: IN_PROJECT },
        { workspace: { kind: "ephemeral", checkouts: [{ resourceId: "res-webshop" }] } },
        MESSAGE,
      ),
    ).toMatchObject({
      input: { workspace: { kind: "ephemeral", checkouts: [{ resourceId: "res-webshop" }] } },
    });
  });

  it("sends nothing of the workspace on an active thread, whose placement is fixed", () => {
    expect(
      submission(ACTIVE, { workspace: { kind: "none" }, projectId: "p-webshop" }, MESSAGE),
    ).toEqual({ kind: "input", sessionId: SESSION.id, payload: { text: "ship it" } });
  });
});
