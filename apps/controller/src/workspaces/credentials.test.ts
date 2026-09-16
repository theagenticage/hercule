/**
 * Git credentials, answered by the controller over the runner socket.
 *
 * A runner never holds a token: it asks per request, naming the
 * remote git is about to talk to and either the session that asked or the
 * workspace it is provisioning, and the controller answers only when that
 * remote is a checkout the asker already has. Everything here is driven as a
 * machine drives it - a `credentialRequest` on the wire, a `credentialAnswer`
 * back - because the wire is the whole of the authorization boundary.
 */
import { describe, expect, it } from "vitest";
import { Effect, Schema } from "effect";
import {
  ConnectionValidationFailed,
  HOST_API,
  registerConnectionType,
  type Plugin,
} from "@hydra/plugin-host";
import type { SessionStart } from "@hydra/protocol";
import { get, post, send } from "../http/testing";
import { framesWhen, spawned, until, type Arranged, type Wire } from "../sessions/testing";
import { framesTagged, provisioned, readWorkspace, repo, withFleet, type Frame } from "./testing";

const LOGIN = "octocat";
const PAT = "ghp_a-token";
const SECOND_PAT = "ghp_another-token";

/** The GitHub type, with its check done here rather than against api.github.com. */
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
const ask = async (wire: Wire, request: Record<string, unknown>): Promise<Frame> => {
  const requestId = crypto.randomUUID();
  wire.send({ _tag: "credentialRequest", requestId, ...request } as never);
  return until(`answered the credential request ${requestId}`, () =>
    framesTagged(wire, "credentialAnswer").find((frame) => frame["requestId"] === requestId),
  );
};

const connection = async (
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
  it("is the connection of its first checkout's resource, and nothing on a scratch workspace", async () => {
    await withCredentials(async (arranged) => {
      const github = await connection(arranged, { pat: PAT });
      const web = await repo(arranged, "https://github.com/acme/web", github);

      const primary = await provisioned(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      expect(primary.designatedConnectionId).toBe(github);

      const scratch = await spawned(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [] },
      });
      const held = await readWorkspace(arranged, String(scratch.workspaceId));
      expect(held.designatedConnectionId).toBeNull();
    });
  });
});

/**
 * D-21 F4: the Connection the work in a workspace acts through is settled when
 * it is opened and stored on the row. Re-deriving it from the first checkout's
 * resource at every read would change what a workspace already standing acts
 * through the moment the resource changed hands.
 */
describe("a workspace whose resource changes hands", () => {
  it("keeps the Connection it was opened against, and answers credentials from it", async () => {
    await withCredentials(async (arranged) => {
      const mine = await connection(arranged, { pat: PAT });
      const web = await repo(arranged, "https://github.com/acme/web", mine);
      const workspace = await provisioned(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      expect(workspace.designatedConnectionId).toBe(mine);

      const other = await connection(arranged, { pat: "ghp_somebody-else" });
      const moved = await send("PATCH", arranged.harness.base, `/api/v1/resources/${web}`, {
        body: { connectionId: other },
        token: arranged.token,
      });
      expect(moved.status, await moved.clone().text()).toBe(200);

      expect((await readWorkspace(arranged, workspace.id)).designatedConnectionId).toBe(mine);
      const answer = await ask(arranged.wire, {
        remote: "github.com/acme/web",
        workspaceId: workspace.id,
      });
      expect(answer["token"]).toBe(PAT);
    });
  });
});

describe("a credential asked for by a provisioning workspace", () => {
  // D-21 F5: the answer is the credential; the git identity rides on the start
  // frame, once, rather than on every credential exchange.
  it("answers with the connection's token and the login it belongs to", async () => {
    await withCredentials(async (arranged) => {
      const github = await connection(arranged, { pat: PAT });
      const web = await repo(arranged, "https://github.com/acme/web", github);
      const workspace = await provisioned(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });

      const answer = await ask(arranged.wire, {
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
      const github = await connection(arranged, { pat: PAT });
      const web = await repo(arranged, "https://github.com/acme/web", github);
      const workspace = await provisioned(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId: workspace.id,
        status: "ready",
        checkouts: [],
      } as never);
      await until("made the workspace ready", async () => {
        const one = await readWorkspace(arranged, workspace.id);
        return one.status === "ready" ? one : undefined;
      });

      const answer = await ask(arranged.wire, {
        remote: "github.com/acme/web",
        workspaceId: workspace.id,
      });
      expect(answer["error"]).toBe("unauthorized");
      expect(answer["token"]).toBeUndefined();
    });
  });

  it("refuses a remote the workspace does not hold, and one no resource matches", async () => {
    await withCredentials(async (arranged) => {
      const github = await connection(arranged, { pat: PAT });
      const web = await repo(arranged, "https://github.com/acme/web", github);
      await repo(arranged, "https://github.com/acme/secrets", github);
      const workspace = await provisioned(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });

      const elsewhere = await ask(arranged.wire, {
        remote: "github.com/acme/secrets",
        workspaceId: workspace.id,
      });
      expect(elsewhere["error"]).toBe("unauthorized");
      expect(elsewhere["token"]).toBeUndefined();

      const nowhere = await ask(arranged.wire, {
        remote: "github.com/someone/else",
        workspaceId: workspace.id,
      });
      expect(nowhere["error"]).toBe("unauthorized");
      expect(nowhere["token"]).toBeUndefined();
    });
  });

  it("says no_connection for a repo that has none", async () => {
    await withCredentials(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");
      const workspace = await provisioned(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });

      const answer = await ask(arranged.wire, {
        remote: "github.com/acme/web",
        workspaceId: workspace.id,
      });
      expect(answer["error"]).toBe("no_connection");
      expect(answer["token"]).toBeUndefined();
    });
  });

  it("refuses a workspace that is not on the machine asking", async () => {
    await withCredentials(async (arranged) => {
      const github = await connection(arranged, { pat: PAT });
      const web = await repo(arranged, "https://github.com/acme/web", github);
      const second = await arranged.enlist();
      const workspace = await provisioned(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });

      const answer = await ask(second.wire, {
        remote: "github.com/acme/web",
        workspaceId: workspace.id,
      });
      expect(answer["error"]).toBe("unauthorized");
      expect(answer["token"]).toBeUndefined();
    });
  });
});

describe("a credential asked for by a session", () => {
  it("refuses the token of a session the machine no longer holds", async () => {
    await withCredentials(async (arranged) => {
      const github = await connection(arranged, { pat: PAT });
      const web = await repo(arranged, "https://github.com/acme/web", github);
      const session = await spawned(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId: String(session.workspaceId),
        status: "ready",
        checkouts: [],
      } as never);
      const start = (await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
      const token = (start as unknown as Frame)["token"];
      expect(token, "the session was started with no token").toBeTruthy();

      // The machine says it holds nothing: the session is over, whether or not
      // it ever reported an exit, and the credential it held is over with it.
      arranged.wire.send({ _tag: "sessionsReport", sessions: [] });
      await until("ended the session", async () => {
        const response = await get(
          arranged.harness.base,
          `/api/v1/sessions/${session.id}`,
          arranged.token,
        );
        const one = (await response.json()) as { status: string };
        return one.status === "exited" ? one : undefined;
      });

      const answer = await ask(arranged.wire, {
        remote: "github.com/acme/web",
        sessionToken: String(token),
      });
      expect(answer["error"]).toBe("unauthorized");
      expect(answer["token"]).toBeUndefined();
    });
  });

  it("refuses a token nobody was issued", async () => {
    await withCredentials(async (arranged) => {
      const github = await connection(arranged, { pat: PAT });
      const web = await repo(arranged, "https://github.com/acme/web", github);
      await provisioned(arranged, { resourceId: web, runnerId: arranged.runnerId });

      const answer = await ask(arranged.wire, {
        remote: "github.com/acme/web",
        sessionToken: "not-a-token-anybody-holds",
      });
      expect(answer["error"]).toBe("unauthorized");
      expect(answer["token"]).toBeUndefined();
    });
  });
});

describe("the GitHub token a session starts with", () => {
  it("rides the start frame from the workspace's designated connection", async () => {
    await withCredentials(async (arranged) => {
      const github = await connection(arranged, { pat: PAT });
      const web = await repo(arranged, "https://github.com/acme/web", github);

      const session = await spawned(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      // The session waits for its worktree, so the machine has to say the
      // workspace stands before there is a start frame to read the token off.
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId: String(session.workspaceId),
        status: "ready",
        checkouts: [],
      } as never);
      const start = (await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
      expect(start.sessionId).toBe(session.id);
      expect((start as unknown as Frame)["ghToken"]).toBe(PAT);
      // The machine commits as the account it pushes with, so the identity
      // rides the same frame the token does.
      expect((start as unknown as Frame)["gitIdentity"]).toEqual({
        name: LOGIN,
        email: `${LOGIN}@users.noreply.github.com`,
      });
    });
  });

  it("falls back to the connection the thread setting names, and is null with neither", async () => {
    await withCredentials(async (arranged) => {
      const bare = await spawned(arranged, { prompt: "hello" });
      const first = (await framesWhen<SessionStart>(arranged.wire, "sessionStart", 1))[0]!;
      expect(first.sessionId).toBe(bare.id);
      expect((first as unknown as Frame)["ghToken"] ?? null).toBeNull();
      expect((first as unknown as Frame)["gitIdentity"] ?? null).toBeNull();

      const fallback = await connection(arranged, { pat: SECOND_PAT });
      const patched = await send("PATCH", arranged.harness.base, "/api/v1/settings", {
        body: { user: { "thread.githubConnectionId": fallback } },
        token: arranged.token,
      });
      expect(patched.status, await patched.clone().text()).toBe(200);

      await spawned(arranged, { prompt: "again" });
      const second = (await framesWhen<SessionStart>(arranged.wire, "sessionStart", 2))[1]!;
      expect((second as unknown as Frame)["ghToken"]).toBe(SECOND_PAT);
    });
  });
});
