/**
 * Tests `buildSubmission(resolved, message)`, which builds the request the
 * composer sends: a spawn for a draft thread and an input for an active one,
 * each tagged with its kind. The thread is resolved from its picks with
 * `resolveThreadConfig`, which owns what applies (see `resolve-thread.test.ts`).
 * A spawn carries everything the draft resolved to. For an active thread, what
 * matters is what it leaves out: a session's access mode and runner are
 * fixed, so an input has the text and only what the picks change.
 */
import { describe, expect, it } from "vitest";
import type { Runner, Session } from "@hercule/contract";
import {
  BARE,
  buildInstance,
  buildSnapshot,
  CLAUDE_CODE_IDENTITY,
  CODEX_IDENTITY,
} from "../providers.testing";
import { addFilesToShelf, markShelfItemUploaded } from "../attachments/shelf";
import type { MessageDraft, ThreadCatalogs, ThreadConfig, ThreadPicks } from "./config";
import { resolveThreadConfig } from "./resolve-thread";
import { buildSubmission } from "./submission";
import { applyThreadChoice } from "./thread-choice";
import { WEBSHOP, WEBSHOP_PROJECT } from "./workspaces.testing";

const NO_CATALOGS: ThreadCatalogs = { instances: [], runners: [], thisMacRunnerId: null };

/** Returns the spawn request for a draft that starts from `config` and holds `picks`. */
const buildDraftSubmission = (
  catalogs: ThreadCatalogs,
  config: ThreadConfig,
  picks: ThreadPicks,
  message: MessageDraft,
) => buildSubmission(resolveThreadConfig(catalogs, { kind: "draft", config }, picks), message);

/** Returns the input request for the thread that has started as `session`, holding `picks`. */
const buildInputSubmission = (
  catalogs: ThreadCatalogs,
  session: Session,
  picks: ThreadPicks,
  message: MessageDraft,
) => buildSubmission(resolveThreadConfig(catalogs, { kind: "active", session }, picks), message);

const CONFIG: ThreadConfig = {
  instanceId: "instance-claude-code",
  model: "claude-sonnet-5",
  accessMode: "approval-required",
  runnerId: "r-local",
  profileId: "p-unrestricted",
  options: {},
};

const SESSION: Session = {
  id: "s1",
  title: "Fix the login bug",
  kind: "thread",
  role: null,
  status: "idle",
  resumable: false,
  resumeHeld: false,
  toolCalls: 0,
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
  openPermissionRequests: [],
  createdAt: "2026-09-08T09:00:00.000Z",
  startedAt: "2026-09-08T09:00:01.000Z",
  exitedAt: null,
  lastActivityAt: "2026-09-08T09:05:00.000Z",
  unenforced: [],
};

const MESSAGE = { text: "ship it", attachments: [] };

const LOCAL: Runner = { ...BARE, id: "r-local" };
const REMOTE: Runner = { ...BARE, id: "r-remote" };
const SONNET = {
  slug: "claude-sonnet-5",
  name: "Claude Sonnet 5",
  imageInput: { maxBytes: null },
  isDefault: true,
  options: [
    {
      id: "effort",
      label: "Effort",
      kind: "select" as const,
      choices: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
      default: "low",
    },
  ],
};
const OPUS = { ...SONNET, slug: "claude-opus-5", name: "Claude Opus 5", isDefault: false };
const CLAUDE = buildInstance(CLAUDE_CODE_IDENTITY, [
  buildSnapshot({ runnerId: LOCAL.id, models: [SONNET, OPUS] }),
  buildSnapshot({ runnerId: REMOTE.id, models: [SONNET, OPUS] }),
]);
const CATALOGS: ThreadCatalogs = {
  instances: [CLAUDE],
  runners: [LOCAL, REMOTE],
  thisMacRunnerId: LOCAL.id,
};

describe("buildSubmission: a draft thread", () => {
  it("spawns with the draft's config, no workspace and the config's profile", () => {
    expect(buildDraftSubmission(NO_CATALOGS, CONFIG, {}, MESSAGE)).toEqual({
      kind: "spawn",
      input: {
        prompt: "ship it",
        instanceId: "instance-claude-code",
        model: "claude-sonnet-5",
        options: {},
        accessMode: "approval-required",
        runnerId: "r-local",
        permissionProfileId: "p-unrestricted",
      },
    });
  });

  it("sends the default runner and model of the account picked, not the draft's own", () => {
    // The draft runs Claude on the local runner. Codex is logged in on the
    // remote runner only, and the picks hold the account alone.
    const codex = buildInstance(CODEX_IDENTITY, [
      buildSnapshot({ runnerId: LOCAL.id, auth: { status: "unauthenticated" }, models: [] }),
      buildSnapshot({
        runnerId: REMOTE.id,
        models: [{ slug: "gpt-5", name: "GPT-5", imageInput: { maxBytes: null }, options: [] }],
      }),
    ]);
    const catalogs = { ...CATALOGS, instances: [CLAUDE, codex] };

    expect(
      buildDraftSubmission(
        catalogs,
        CONFIG,
        applyThreadChoice({}, { kind: "account", instanceId: codex.id }),
        MESSAGE,
      ),
    ).toMatchObject({
      input: { instanceId: codex.id, model: "gpt-5", runnerId: "r-remote", options: {} },
    });
  });

  it("sends what the user picked: model, options, access mode and runner", () => {
    const picks = [
      { kind: "model", instanceId: CLAUDE.id, model: OPUS.slug },
      { kind: "option", id: "effort", value: "high" },
      { kind: "accessMode", value: "full-access" },
      { kind: "runner", runnerId: REMOTE.id },
    ] as const;
    expect(
      buildDraftSubmission(
        CATALOGS,
        { ...CONFIG, instanceId: CLAUDE.id },
        picks.reduce(applyThreadChoice, {} as ThreadPicks),
        MESSAGE,
      ),
    ).toEqual({
      kind: "spawn",
      input: {
        prompt: "ship it",
        instanceId: CLAUDE.id,
        model: OPUS.slug,
        options: { effort: "high" },
        accessMode: "full-access",
        runnerId: REMOTE.id,
        permissionProfileId: "p-unrestricted",
      },
    });
  });
});

describe("buildSubmission: an active thread", () => {
  const session: Session = { ...SESSION, instanceId: CLAUDE.id, runnerId: LOCAL.id };

  it("sends the text alone when nothing was picked", () => {
    expect(buildInputSubmission(CATALOGS, session, {}, MESSAGE)).toEqual({
      kind: "input",
      sessionId: SESSION.id,
      payload: { text: "ship it" },
    });
  });

  it("sends a picked model with the text", () => {
    expect(buildInputSubmission(CATALOGS, session, { model: OPUS.slug }, MESSAGE)).toEqual({
      kind: "input",
      sessionId: SESSION.id,
      payload: { text: "ship it", model: OPUS.slug },
    });
  });

  it("sends picked options with the text", () => {
    expect(
      buildInputSubmission(CATALOGS, session, { options: { effort: "high" } }, MESSAGE),
    ).toEqual({
      kind: "input",
      sessionId: SESSION.id,
      payload: { text: "ship it", options: { effort: "high" } },
    });
  });

  it("sends both when both were picked", () => {
    expect(
      buildInputSubmission(
        CATALOGS,
        session,
        { model: OPUS.slug, options: { effort: "high" } },
        MESSAGE,
      ),
    ).toEqual({
      kind: "input",
      sessionId: SESSION.id,
      payload: { text: "ship it", model: OPUS.slug, options: { effort: "high" } },
    });
  });

  it("sends no other key, whatever else the picks hold", () => {
    expect(
      buildInputSubmission(
        CATALOGS,
        session,
        {
          accessMode: "full-access",
          runnerId: "r-remote",
          workspace: { kind: "none" },
          projectId: "p-webshop",
        },
        MESSAGE,
      ),
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
const IN_PROJECT: ThreadConfig = {
  ...CONFIG,
  projectId: "p-webshop",
  preferredWorkspace: null,
  workspace: { kind: "primary", resourceId: "res-webshop" },
};

describe("buildSubmission: the project and the workspace", () => {
  it("sends the project and the main workspace the draft works in", () => {
    expect(buildDraftSubmission(NO_CATALOGS, IN_PROJECT, {}, MESSAGE)).toEqual({
      kind: "spawn",
      input: {
        prompt: "ship it",
        instanceId: "instance-claude-code",
        model: "claude-sonnet-5",
        options: {},
        accessMode: "approval-required",
        runnerId: "r-local",
        permissionProfileId: "p-unrestricted",
        projectId: "p-webshop",
        workspace: { kind: "primary", resourceId: "res-webshop" },
      },
    });
  });

  it("leaves the actual shared branch unchanged despite an old saved branch pick", () => {
    const sent = buildDraftSubmission(
      NO_CATALOGS,
      {
        ...IN_PROJECT,
        workspace: { kind: "primary", resourceId: "res-webshop", branch: "release/2.4" },
      },
      {},
      MESSAGE,
    );

    expect(sent.input.workspace).toEqual({ kind: "primary", resourceId: "res-webshop" });
  });

  it("sends one checkout per repo, with each one's base branch", () => {
    const workspace = {
      kind: "ephemeral" as const,
      checkouts: [
        { resourceId: "res-infra", baseBranch: "master" },
        { resourceId: "res-runbooks" },
      ],
    };

    expect(
      buildDraftSubmission(
        NO_CATALOGS,
        { ...IN_PROJECT, projectId: "p-ops", workspace },
        {},
        MESSAGE,
      ).input,
    ).toMatchObject({ projectId: "p-ops", workspace });
  });

  it("sends the workspace a thread joins", () => {
    const workspace = { kind: "existing" as const, workspaceId: "ws-thread-3f1" };

    expect(
      buildDraftSubmission(NO_CATALOGS, { ...IN_PROJECT, workspace }, {}, MESSAGE).input.workspace,
    ).toEqual(workspace);
  });

  it("sends no workspace at all for a thread that works without a checkout", () => {
    const { input } = buildDraftSubmission(
      NO_CATALOGS,
      { ...IN_PROJECT, workspace: { kind: "none" } },
      {},
      MESSAGE,
    );

    expect(input.workspace).toBeUndefined();
    expect(input.projectId).toBe("p-webshop");
  });

  it("sends neither key for a draft with no project and no workspace", () => {
    const { input } = buildDraftSubmission(
      NO_CATALOGS,
      { ...IN_PROJECT, projectId: null, workspace: null },
      {},
      MESSAGE,
    );

    expect(input.projectId).toBeUndefined();
    expect(input.workspace).toBeUndefined();
  });

  it("applies a workspace picked since the draft was built", () => {
    const workspace = { kind: "ephemeral" as const, checkouts: [{ resourceId: "res-webshop" }] };

    expect(
      buildDraftSubmission(NO_CATALOGS, IN_PROJECT, { workspace }, MESSAGE).input.workspace,
    ).toEqual(workspace);
  });

  it("starts in the default workspace the composer shows when none is picked or named", () => {
    const catalogs = { ...NO_CATALOGS, projects: [WEBSHOP_PROJECT], resources: [WEBSHOP] };
    const config: ThreadConfig = {
      ...IN_PROJECT,
      projectId: WEBSHOP_PROJECT.id,
      workspace: null,
    };

    expect(buildDraftSubmission(catalogs, config, {}, MESSAGE).input.workspace).toEqual({
      kind: "ephemeral",
      checkouts: [{ resourceId: WEBSHOP.id }],
    });
  });
});

describe("buildSubmission: images", () => {
  // Two images on the shelf: the first uploaded, the second still uploading.
  const { shelf } = addFilesToShelf(
    [],
    ["one.png", "two.png"].map((name) =>
      Object.assign(new Blob([new Uint8Array(4)], { type: "image/png" }), { name }),
    ),
    { imageInput: { maxBytes: null }, modelName: "Claude Sonnet 5" },
  );
  const attachments = markShelfItemUploaded(shelf, shelf[0]!.key, {
    id: "att-1",
    name: "one.png",
    mimeType: "image/png",
    sizeBytes: 4,
  });

  it("sends the ids of the uploaded images, with or without text", () => {
    expect(buildInputSubmission(NO_CATALOGS, SESSION, {}, { text: "", attachments })).toEqual({
      kind: "input",
      sessionId: SESSION.id,
      payload: { text: "", attachments: ["att-1"] },
    });
    expect(
      buildDraftSubmission(NO_CATALOGS, CONFIG, {}, { text: "look", attachments }).input,
    ).toMatchObject({
      prompt: "look",
      attachments: ["att-1"],
    });
  });
});
