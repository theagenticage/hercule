/**
 * Git credentials, answered by the controller over the runner socket.
 *
 * A runner never holds a token. It asks for one per request, naming the remote
 * git is about to contact and either the session that asked or the workspace
 * it is provisioning. The controller returns a token only when the asker
 * already has a checkout of that remote. These tests drive the exchange the
 * way a runner does - a `credentialRequest` on the wire, a `credentialAnswer`
 * back - because the wire is the whole authorization boundary.
 */
import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import {
  ConnectionValidationFailed,
  HOST_API,
  registerConnectionType,
  type Plugin,
} from "@hercule/plugin-host";
import type { SessionStart } from "@hercule/protocol";
import { get, post, send } from "../http/testing";
import {
  waitForFrames,
  spawnSessionOrFail,
  waitUntil,
  type Arranged,
  type Wire,
} from "../sessions/testing";
import {
  listFramesTagged,
  provisionWorkspaceOrFail,
  readWorkspace,
  createRepo,
  withFleet,
  type Frame,
} from "./testing";

const LOGIN = "octocat";
const PAT = "ghp_a-token";
const SECOND_PAT = "ghp_another-token";

/** The GitHub connection type, validating tokens locally rather than against api.github.com. */
const githubPlugin: Plugin = {
  manifest: {
    id: "github",
    displayName: "GitHub",
    hostApi: HOST_API,
    capabilities: ["connections"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    registerConnectionType(host, {
      type: "github",
      displayName: "GitHub",
      setup: [{ kind: "credentials", fields: [{ name: "pat", label: "Personal access token" }] }],
      validate: (credentials: Record<string, string>) => {
        const pat = credentials["pat"] ?? "";
        return pat.startsWith("ghp_")
          ? Effect.succeed({ displayName: pat === PAT ? LOGIN : "hubot" })
          : Effect.fail(new ConnectionValidationFailed({ message: "GitHub rejected the token." }));
      },
    }),
  activate: () => Effect.succeed(Effect.void),
};

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

const createConnection = async (
  arranged: Arranged,
  credentials: Record<string, string>,
): Promise<string> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/connections",
    { type: "github/github", label: "work", labels: ["Code"], credentials },
    arranged.token,
  );
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { id: string }).id;
};

describe("the designated connection of a workspace", () => {
  it("is the connection of its first checkout's resource, and null for a scratch workspace", async () => {
    await withCredentials(async (arranged) => {
      const github = await createConnection(arranged, { pat: PAT });
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
      const mine = await createConnection(arranged, { pat: PAT });
      const web = await createRepo(arranged, "https://github.com/acme/web", mine);
      const workspace = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      expect(workspace.designatedConnectionId).toBe(mine);

      const other = await createConnection(arranged, { pat: "ghp_somebody-else" });
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
      expect(answer["token"]).toBe(PAT);
    });
  });
});

describe("a credential asked for by a provisioning workspace", () => {
  // The answer carries only the credential. The git identity is sent once, on
  // the session start frame, rather than on every credential exchange.
  it("answers with the connection's token and the login it belongs to", async () => {
    await withCredentials(async (arranged) => {
      const github = await createConnection(arranged, { pat: PAT });
      const web = await createRepo(arranged, "https://github.com/acme/web", github);
      const workspace = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });

      const answer = await askForCredential(arranged.wire, {
        remote: "github.com/acme/web",
        workspaceId: workspace.id,
      });
      expect(answer["token"]).toBe(PAT);
      expect(answer["username"]).toBe(LOGIN);
      expect(answer["name"]).toBeUndefined();
      expect(answer["email"]).toBeUndefined();
      expect(answer["error"]).toBeUndefined();
    });
  });

  it("stops answering once the workspace is no longer provisioning", async () => {
    await withCredentials(async (arranged) => {
      const github = await createConnection(arranged, { pat: PAT });
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
      const github = await createConnection(arranged, { pat: PAT });
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
      const github = await createConnection(arranged, { pat: PAT });
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

describe("a credential asked for by a session", () => {
  it("rejects the token of a session the runner no longer reports", async () => {
    await withCredentials(async (arranged) => {
      const github = await createConnection(arranged, { pat: PAT });
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
      const github = await createConnection(arranged, { pat: PAT });
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
      const github = await createConnection(arranged, { pat: PAT });
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
      expect((start as unknown as Frame)["ghToken"]).toBe(PAT);
      // The session commits as the account it pushes with, so the identity
      // is sent on the same frame as the token.
      expect((start as unknown as Frame)["gitIdentity"]).toEqual({
        name: LOGIN,
        email: `${LOGIN}@users.noreply.github.com`,
      });
    });
  });

  it("falls back to the connection in the thread setting, and is null when there is neither", async () => {
    await withCredentials(async (arranged) => {
      const bare = await spawnSessionOrFail(arranged, { prompt: "hello" });
      const first = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
      expect(first.sessionId).toBe(bare.id);
      expect((first as unknown as Frame)["ghToken"] ?? null).toBeNull();
      expect((first as unknown as Frame)["gitIdentity"] ?? null).toBeNull();

      const fallback = await createConnection(arranged, { pat: SECOND_PAT });
      const patched = await send("PATCH", arranged.harness.base, "/api/v1/settings", {
        body: { user: { "thread.githubConnectionId": fallback } },
        token: arranged.token,
      });
      expect(patched.status, await patched.clone().text()).toBe(200);

      await spawnSessionOrFail(arranged, { prompt: "again" });
      const second = (await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 2))[1]!;
      expect((second as unknown as Frame)["ghToken"]).toBe(SECOND_PAT);
    });
  });
});
