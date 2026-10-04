/**
 * Git credentials, answered by the controller over the runner socket.
 *
 * A runner never holds a token. It asks for one per request, naming the remote
 * git is about to contact and either the session that asked or a workspace
 * the runner is provisioning or running a workspace step in. The controller
 * returns a token only when the asker already has a checkout of that remote.
 * These tests drive the exchange the way a runner does - a
 * `credentialRequest` on the wire, a `credentialAnswer` back - because the
 * wire is the whole authorization boundary.
 */
import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import type { SessionStart } from "@hercule/protocol";
import { OAUTH_TOKENS } from "../connections";
import { get, post, send } from "../http/testing";
import { findStepRecords, startSentWorkflow, waitForRun } from "../runs/testing";
import {
  waitForFrames,
  waitForStartFrames,
  spawnSessionOrFail,
  waitUntil,
  type Arranged,
  type Wire,
} from "../sessions/testing";
import {
  createGithubConnection,
  githubPlugin,
  listFramesTagged,
  provisionWorkspaceOrFail,
  readWorkspace,
  createRepo,
  withFleet,
  GITHUB_LOGIN,
  GITHUB_PAT,
  type Frame,
} from "./testing";
import {
  readDefaultConversation,
  sendMessage,
  waitForConversationSessions,
} from "../conversations/testing";

const SECOND_PAT = "ghp_another-token";

/** An access token as the GitHub device flow issues one. */
const DEVICE_TOKEN = "gho_a-device-token";

const withCredentials = (body: (arranged: Arranged) => Promise<void>): Promise<void> =>
  withFleet(body, { plugins: [githubPlugin] });

/** Asks for a credential the way a runner does, and waits for the answer to it. */
const askForCredential = async (wire: Wire, request: Record<string, unknown>): Promise<Frame> => {
  const requestId = crypto.randomUUID();
  wire.send({ _tag: "credentialRequest", requestId, ...request } as never);
  return waitUntil(`answered the credential request ${requestId}`, () =>
    listFramesTagged(wire, "credentialAnswer").find((frame) => frame["requestId"] === requestId),
  );
};

describe("the designated connection of a workspace", () => {
  it("is the connection of its first checkout's resource, and null for a scratch workspace", async () => {
    await withCredentials(async (arranged) => {
      const github = await createGithubConnection(arranged, { pat: GITHUB_PAT });
      const web = await createRepo(arranged, "https://github.com/acme/web", github);

      const primary = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      expect(primary.designatedConnectionId).toBe(github);

      const scratch = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [] },
      });
      const held = await readWorkspace(arranged, String(scratch.workspaceId));
      expect(held.designatedConnectionId).toBeNull();
    });
  });
});

/**
 * The Connection that work in a workspace acts through is fixed when the
 * workspace is opened, and stored on the row. If it were derived from the
 * first checkout's resource at every read, an existing workspace would switch
 * accounts as soon as its resource moved to another Connection.
 */
describe("a workspace whose resource moves to another Connection", () => {
  it("keeps the Connection it was opened with, and answers credentials from it", async () => {
    await withCredentials(async (arranged) => {
      const mine = await createGithubConnection(arranged, { pat: GITHUB_PAT });
      const web = await createRepo(arranged, "https://github.com/acme/web", mine);
      const workspace = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      expect(workspace.designatedConnectionId).toBe(mine);

      const other = await createGithubConnection(arranged, { pat: "ghp_somebody-else" });
      const moved = await send("PATCH", arranged.harness.base, `/api/v1/resources/${web}`, {
        body: { connectionId: other },
        token: arranged.token,
      });
      expect(moved.status, await moved.clone().text()).toBe(200);

      expect((await readWorkspace(arranged, workspace.id)).designatedConnectionId).toBe(mine);
      const answer = await askForCredential(arranged.wire, {
        remote: "github.com/acme/web",
        workspaceId: workspace.id,
      });
      expect(answer["token"]).toBe(GITHUB_PAT);
    });
  });
});

describe("a credential asked for by a provisioning workspace", () => {
  // The answer carries only the credential. The git identity is sent once, on
  // the session start frame, rather than on every credential exchange.
  it("answers with the connection's token and the login it belongs to", async () => {
    await withCredentials(async (arranged) => {
      const github = await createGithubConnection(arranged, { pat: GITHUB_PAT });
      const web = await createRepo(arranged, "https://github.com/acme/web", github);
      const workspace = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });

      const answer = await askForCredential(arranged.wire, {
        remote: "github.com/acme/web",
        workspaceId: workspace.id,
      });
      expect(answer["token"]).toBe(GITHUB_PAT);
      expect(answer["username"]).toBe(GITHUB_LOGIN);
      expect(answer["name"]).toBeUndefined();
      expect(answer["email"]).toBeUndefined();
      expect(answer["error"]).toBeUndefined();
    });
  });

  /**
   * Replaces a GitHub connection's pasted token with a device flow's token
   * set. The test GitHub type has no device flow, and the API refuses to
   * write a connection's secrets, so the test swaps them in the secrets
   * repository to arrive at the same state.
   */
  const storeDeviceTokens = async (
    arranged: Arranged,
    connectionId: string,
    tokens: { readonly accessToken: string; readonly expiresAt?: string },
  ): Promise<void> => {
    const { secrets } = arranged.harness;
    const owner = { kind: "connection", id: connectionId } as const;
    const droppedPat = await Effect.runPromise(
      Effect.andThen(
        secrets.set(owner, OAUTH_TOKENS, Redacted.make(JSON.stringify(tokens))),
        secrets.delete(owner, "pat"),
      ),
    );
    expect(droppedPat).toBe(true);
  };

  it("answers with the access token of a connection set up through the device flow", async () => {
    await withCredentials(async (arranged) => {
      const github = await createGithubConnection(arranged, { pat: GITHUB_PAT });
      await storeDeviceTokens(arranged, github, { accessToken: DEVICE_TOKEN });
      const web = await createRepo(arranged, "https://github.com/acme/web", github);
      const workspace = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });

      const answer = await askForCredential(arranged.wire, {
        remote: "github.com/acme/web",
        workspaceId: workspace.id,
      });
      expect(answer["token"]).toBe(DEVICE_TOKEN);
      expect(answer["username"]).toBe(GITHUB_LOGIN);
      expect(answer["error"]).toBeUndefined();
    });
  });

  it("answers no_connection, and leaves the connection's status alone, when the device flow's token has expired", async () => {
    await withCredentials(async (arranged) => {
      const github = await createGithubConnection(arranged, { pat: GITHUB_PAT });
      await storeDeviceTokens(arranged, github, {
        accessToken: DEVICE_TOKEN,
        expiresAt: "2020-01-01T00:00:00.000Z",
      });
      const web = await createRepo(arranged, "https://github.com/acme/web", github);
      const workspace = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });

      const answer = await askForCredential(arranged.wire, {
        remote: "github.com/acme/web",
        workspaceId: workspace.id,
      });
      expect(answer["error"]).toBe("no_connection");
      expect(answer["token"]).toBeUndefined();
      // Reading the token is a plain read: it does not mark the connection.
      const read = await get(
        arranged.harness.base,
        `/api/v1/connections/${github}`,
        arranged.token,
      );
      expect(read.status, await read.clone().text()).toBe(200);
      expect(await read.json()).toMatchObject({ status: "connected" });
    });
  });

  it("stops answering once the workspace is no longer provisioning", async () => {
    await withCredentials(async (arranged) => {
      const github = await createGithubConnection(arranged, { pat: GITHUB_PAT });
      const web = await createRepo(arranged, "https://github.com/acme/web", github);
      const workspace = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId: workspace.id,
        status: "ready",
        checkouts: [],
      } as never);
      await waitUntil("made the workspace ready", async () => {
        const one = await readWorkspace(arranged, workspace.id);
        return one.status === "ready" ? one : undefined;
      });

      const answer = await askForCredential(arranged.wire, {
        remote: "github.com/acme/web",
        workspaceId: workspace.id,
      });
      expect(answer["error"]).toBe("unauthorized");
      expect(answer["token"]).toBeUndefined();
    });
  });

  it("rejects a remote the workspace has no checkout of, and a remote that matches no resource", async () => {
    await withCredentials(async (arranged) => {
      const github = await createGithubConnection(arranged, { pat: GITHUB_PAT });
      const web = await createRepo(arranged, "https://github.com/acme/web", github);
      await createRepo(arranged, "https://github.com/acme/secrets", github);
      const workspace = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });

      const elsewhere = await askForCredential(arranged.wire, {
        remote: "github.com/acme/secrets",
        workspaceId: workspace.id,
      });
      expect(elsewhere["error"]).toBe("unauthorized");
      expect(elsewhere["token"]).toBeUndefined();

      const nowhere = await askForCredential(arranged.wire, {
        remote: "github.com/someone/else",
        workspaceId: workspace.id,
      });
      expect(nowhere["error"]).toBe("unauthorized");
      expect(nowhere["token"]).toBeUndefined();
    });
  });

  it("answers no_connection for a repo with no Connection", async () => {
    await withCredentials(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const workspace = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });

      const answer = await askForCredential(arranged.wire, {
        remote: "github.com/acme/web",
        workspaceId: workspace.id,
      });
      expect(answer["error"]).toBe("no_connection");
      expect(answer["token"]).toBeUndefined();
    });
  });

  it("rejects a workspace that is not on the runner asking", async () => {
    await withCredentials(async (arranged) => {
      const github = await createGithubConnection(arranged, { pat: GITHUB_PAT });
      const web = await createRepo(arranged, "https://github.com/acme/web", github);
      const second = await arranged.enlist();
      const workspace = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });

      const answer = await askForCredential(second.wire, {
        remote: "github.com/acme/web",
        workspaceId: workspace.id,
      });
      expect(answer["error"]).toBe("unauthorized");
      expect(answer["token"]).toBeUndefined();
    });
  });
});

describe("a credential asked for by a runner running a workspace step", () => {
  /**
   * Starts a run whose first step pushes in an ephemeral workspace of `repoId`
   * and whose second step waits an hour on the controller. Returns the run's
   * id and its workspace's id once the push step has been sent to the runner.
   * The workspace is then reported ready, so it is no longer `provisioning`
   * and only the running step can entitle the runner to a credential.
   */
  const startPushRun = async (
    arranged: Arranged,
    repoId: string,
  ): Promise<{ readonly runId: string; readonly workspaceId: string }> => {
    const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
      definition: {
        name: "Push, then wait",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: repoId }] },
        steps: [
          { id: "push", kind: "action", action: "git.push", params: {} },
          { id: "pause", kind: "action", action: "wait", params: { seconds: 3600 } },
        ],
        edges: [{ from: "push", to: "pause" }],
      },
    });
    const start = await waitUntil("sent the push step", () =>
      listFramesTagged(arranged.wire, "workspaceStepStart").find(
        (frame) => frame["runId"] === runId,
      ),
    );
    const workspaceId = String(start["workspaceId"]);
    arranged.wire.send({
      _tag: "workspaceReport",
      workspaceId,
      status: "ready",
      checkouts: [],
    } as never);
    await waitUntil("made the workspace ready", async () => {
      const one = await readWorkspace(arranged, workspaceId);
      return one.status === "ready" ? one : undefined;
    });
    return { runId, workspaceId };
  };

  it("answers while the step runs in that workspace on that runner, and refuses once it has ended", async () => {
    await withCredentials(async (arranged) => {
      const github = await createGithubConnection(arranged, { pat: GITHUB_PAT });
      const web = await createRepo(arranged, "https://github.com/acme/web", github);
      const { runId, workspaceId } = await startPushRun(arranged, web);

      const during = await askForCredential(arranged.wire, {
        remote: "github.com/acme/web",
        workspaceId,
      });
      expect(during["token"]).toBe(GITHUB_PAT);
      expect(during["username"]).toBe(GITHUB_LOGIN);

      arranged.wire.send({
        _tag: "workspaceStepResult",
        runId,
        stepId: "push",
        iteration: 1,
        outcome: { status: "completed", output: { branch: `hercule/run-${runId}`, sha: "abc123" } },
      });
      await waitForRun(arranged.harness.base, arranged.token, runId, "waiting", (run) =>
        findStepRecords(run, "pause").some((record) => record.status === "running"),
      );

      // The run is still running and pinned to this runner, but its running
      // step is `wait`, which runs on the controller and pushes nothing.
      const after = await askForCredential(arranged.wire, {
        remote: "github.com/acme/web",
        workspaceId,
      });
      expect(after["error"]).toBe("unauthorized");
      expect(after["token"]).toBeUndefined();
    });
  });

  it("refuses while a failed run's workspace is kept for inspection", async () => {
    await withCredentials(async (arranged) => {
      const github = await createGithubConnection(arranged, { pat: GITHUB_PAT });
      const web = await createRepo(arranged, "https://github.com/acme/web", github);
      const { runId, workspaceId } = await startPushRun(arranged, web);

      arranged.wire.send({
        _tag: "workspaceStepResult",
        runId,
        stepId: "push",
        iteration: 1,
        outcome: { status: "failed", code: "action_failed", message: "rejected" },
      });
      await waitForRun(
        arranged.harness.base,
        arranged.token,
        runId,
        "failed",
        (run) => run.status === "failed",
      );
      expect((await readWorkspace(arranged, workspaceId)).keptUntil).not.toBeNull();

      // The workspace still holds the checkout, but no step runs in it.
      const kept = await askForCredential(arranged.wire, {
        remote: "github.com/acme/web",
        workspaceId,
      });
      expect(kept["error"]).toBe("unauthorized");
      expect(kept["token"]).toBeUndefined();
    });
  });

  it("refuses another runner, and a remote the workspace has no checkout of", async () => {
    await withCredentials(async (arranged) => {
      const github = await createGithubConnection(arranged, { pat: GITHUB_PAT });
      const web = await createRepo(arranged, "https://github.com/acme/web", github);
      await createRepo(arranged, "https://github.com/acme/secrets", github);
      const second = await arranged.enlist();
      const { workspaceId } = await startPushRun(arranged, web);

      const elsewhere = await askForCredential(second.wire, {
        remote: "github.com/acme/web",
        workspaceId,
      });
      expect(elsewhere["error"]).toBe("unauthorized");
      expect(elsewhere["token"]).toBeUndefined();

      const foreign = await askForCredential(arranged.wire, {
        remote: "github.com/acme/secrets",
        workspaceId,
      });
      expect(foreign["error"]).toBe("unauthorized");
      expect(foreign["token"]).toBeUndefined();

      // The step is still running here, so the same request for the
      // workspace's own remote is answered.
      const own = await askForCredential(arranged.wire, {
        remote: "github.com/acme/web",
        workspaceId,
      });
      expect(own["token"]).toBe(GITHUB_PAT);
    });
  });
});

describe("a credential asked for by a session", () => {
  it("answers a running session, and rejects its token once the runner no longer reports it", async () => {
    await withCredentials(async (arranged) => {
      const github = await createGithubConnection(arranged, { pat: GITHUB_PAT });
      const web = await createRepo(arranged, "https://github.com/acme/web", github);
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId: String(session.workspaceId),
        status: "ready",
        checkouts: [],
      } as never);
      const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
      const token = (start as unknown as Frame)["token"];
      expect(token, "the session was started with no token").toBeTruthy();

      // The running session holds an active lease on its workspace.
      const during = await askForCredential(arranged.wire, {
        remote: "github.com/acme/web",
        sessionToken: String(token),
      });
      expect(during["token"]).toBe(GITHUB_PAT);

      // The runner reports no sessions, so the session has ended, whether or
      // not it ever reported an exit, and its token stops working with it.
      arranged.wire.send({ _tag: "sessionsReport", sessions: [] });
      await waitUntil("ended the session", async () => {
        const response = await get(
          arranged.harness.base,
          `/api/v1/sessions/${session.id}`,
          arranged.token,
        );
        const one = (await response.json()) as { status: string };
        return one.status === "exited" ? one : undefined;
      });

      const answer = await askForCredential(arranged.wire, {
        remote: "github.com/acme/web",
        sessionToken: String(token),
      });
      expect(answer["error"]).toBe("unauthorized");
      expect(answer["token"]).toBeUndefined();
    });
  });

  it("rejects a token that was never issued", async () => {
    await withCredentials(async (arranged) => {
      const github = await createGithubConnection(arranged, { pat: GITHUB_PAT });
      const web = await createRepo(arranged, "https://github.com/acme/web", github);
      await provisionWorkspaceOrFail(arranged, { resourceId: web, runnerId: arranged.runnerId });

      const answer = await askForCredential(arranged.wire, {
        remote: "github.com/acme/web",
        sessionToken: "not-a-token-anybody-holds",
      });
      expect(answer["error"]).toBe("unauthorized");
      expect(answer["token"]).toBeUndefined();
    });
  });
});

describe("the GitHub token a session starts with", () => {
  it("is sent on the start frame, from the workspace's designated connection", async () => {
    await withCredentials(async (arranged) => {
      const github = await createGithubConnection(arranged, { pat: GITHUB_PAT });
      const web = await createRepo(arranged, "https://github.com/acme/web", github);

      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      // The session waits for its worktree, so the runner has to report the
      // workspace ready before there is a start frame to read the token from.
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId: String(session.workspaceId),
        status: "ready",
        checkouts: [],
      } as never);
      const start = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
      expect(start.sessionId).toBe(session.id);
      expect((start as unknown as Frame)["ghToken"]).toBe(GITHUB_PAT);
      // The session commits as the account it pushes with, so the identity
      // is sent on the same frame as the token.
      expect((start as unknown as Frame)["gitIdentity"]).toEqual({
        name: GITHUB_LOGIN,
        email: `${GITHUB_LOGIN}@users.noreply.github.com`,
      });
    });
  });

  it("falls back to the GitHub default setting, and is null when it is unset or cleared", async () => {
    await withCredentials(async (arranged) => {
      const bare = await spawnSessionOrFail(arranged, { prompt: "hello" });
      const first = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
      expect(first.sessionId).toBe(bare.id);
      expect((first as unknown as Frame)["ghToken"] ?? null).toBeNull();
      expect((first as unknown as Frame)["gitIdentity"] ?? null).toBeNull();

      const fallback = await createGithubConnection(arranged, { pat: SECOND_PAT });
      const patched = await send("PATCH", arranged.harness.base, "/api/v1/settings", {
        body: { user: { "github.defaultConnectionId": fallback } },
        token: arranged.token,
      });
      expect(patched.status, await patched.clone().text()).toBe(200);

      await spawnSessionOrFail(arranged, { prompt: "again" });
      const second = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2))[1]!;
      expect((second as unknown as Frame)["ghToken"]).toBe(SECOND_PAT);

      const cleared = await send("PATCH", arranged.harness.base, "/api/v1/settings", {
        body: { user: { "github.defaultConnectionId": null } },
        token: arranged.token,
      });
      expect(cleared.status, await cleared.clone().text()).toBe(200);

      await spawnSessionOrFail(arranged, { prompt: "once more" });
      const third = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 3))[2]!;
      expect((third as unknown as Frame)["ghToken"] ?? null).toBeNull();
    });
  });

  it("follows the GitHub default setting for a conversation session placed by conversation.send, and is null when unset", async () => {
    await withCredentials(async (arranged) => {
      const unset = await readDefaultConversation(arranged);
      await sendMessage(arranged, unset.conversation.id, "hi");
      const [bare] = await waitForConversationSessions(arranged, unset.conversation.id, 1);
      expect(bare!.workspaceId).toBeNull();
      const [first] = await waitForStartFrames(arranged, bare!.id, 1);
      expect((first as unknown as Frame)["ghToken"] ?? null).toBeNull();
      expect((first as unknown as Frame)["gitIdentity"] ?? null).toBeNull();

      const fallback = await createGithubConnection(arranged, { pat: SECOND_PAT });
      const patched = await send("PATCH", arranged.harness.base, "/api/v1/settings", {
        body: { user: { "github.defaultConnectionId": fallback } },
        token: arranged.token,
      });
      expect(patched.status, await patched.clone().text()).toBe(200);
      // A second assistant, so its first line places a new session that reads
      // the setting as it is now.
      const created = await post(
        arranged.harness.base,
        "/api/v1/assistants",
        { name: "Ada" },
        arranged.token,
      );
      expect(created.ok, await created.clone().text()).toBe(true);
      const ada = (await created.json()) as { id: string };
      const conversations = await get(
        arranged.harness.base,
        `/api/v1/conversations?assistantId=${ada.id}`,
        arranged.token,
      );
      const [web] = ((await conversations.json()) as { items: ReadonlyArray<{ id: string }> })
        .items;

      await sendMessage(arranged, web!.id, "hi");

      const [placed] = await waitForConversationSessions(arranged, web!.id, 1);
      expect(placed!.workspaceId).toBeNull();
      const [start] = await waitForStartFrames(arranged, placed!.id, 1);
      expect((start as unknown as Frame)["ghToken"]).toBe(SECOND_PAT);
    });
  });
});
