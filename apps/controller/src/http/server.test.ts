/**
 * Tests the controller's listener end to end over a real socket: the order the
 * checks run in, the envelope on every failure, and which operations a request
 * reaches.
 *
 * The test server, temporary home and request helpers come from
 * `./testing.ts`, like every other transport test.
 */
import { describe, expect, it } from "vitest";
import {
  completeSetup,
  del,
  get,
  PASSWORD,
  post,
  SETUP_TOKEN,
  USERNAME,
  withServer,
} from "./testing";
import { RUNNER_ATTACHMENTS_PATH } from "@hercule/protocol";
import { MAX_REQUEST_BODY_BYTES, MAX_UPLOAD_BODY_BYTES } from "./server";

describe("before setup completes", () => {
  it("serves setup.read without a credential, so the web app knows where to route", async () => {
    await withServer(async ({ base }) => {
      const response = await fetch(`${base}/api/v1/setup`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ complete: false });
    });
  });

  it("returns 401 for every other operation, with or without a credential", async () => {
    await withServer(async ({ base }) => {
      const anonymous = await fetch(`${base}/api/v1/settings`);
      const withBearer = await fetch(`${base}/api/v1/settings`, {
        headers: { authorization: "Bearer looks-like-a-token" },
      });

      expect(anonymous.status).toBe(401);
      expect(withBearer.status).toBe(401);
      expect(await anonymous.json()).toMatchObject({ error: { code: "unauthenticated" } });
    });
  });

  it("returns 401 for login too, because there is no user to log in as yet", async () => {
    await withServer(async ({ base }) => {
      const response = await post(base, "/api/v1/auth/login", {
        username: USERNAME,
        password: PASSWORD,
      });
      expect(response.status).toBe(401);
    });
  });

  it("rejects setup.complete without the setup token, and with the wrong one", async () => {
    await withServer(async ({ base }) => {
      const input = { username: USERNAME, password: PASSWORD, timezone: "Europe/Amsterdam" };
      expect((await post(base, "/api/v1/setup/complete", input)).status).toBe(401);
      expect((await post(base, "/api/v1/setup/complete", input, "wrong")).status).toBe(401);
    });
  });
});

describe("setup, login and logout", () => {
  it("completes setup once, and reports it as complete afterwards", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      expect(token).not.toBe("");

      expect(await (await fetch(`${base}/api/v1/setup`)).json()).toEqual({ complete: true });

      const again = await post(
        base,
        "/api/v1/setup/complete",
        { username: "someone", password: PASSWORD, timezone: "UTC" },
        SETUP_TOKEN,
      );
      // The token is used up, so the credential check fails before the setup
      // state is checked.
      expect(again.status).toBe(401);
    });
  });

  it("logs in with the password and logs out again, which invalidates the token", async () => {
    await withServer(async ({ base }) => {
      await completeSetup(base);

      const login = await post(base, "/api/v1/auth/login", {
        username: USERNAME,
        password: PASSWORD,
      });
      expect(login.status).toBe(200);
      const { token } = (await login.json()) as { token: string };

      const logout = await post(base, "/api/v1/auth/logout", {}, token);
      expect(logout.status).toBe(200);

      const after = await post(base, "/api/v1/auth/logout", {}, token);
      expect(after.status).toBe(401);
    });
  });

  it("returns 401 for a wrong password without saying whether the username or the password was wrong", async () => {
    await withServer(async ({ base }) => {
      await completeSetup(base);
      const response = await post(base, "/api/v1/auth/login", {
        username: USERNAME,
        password: "guess",
      });

      expect(response.status).toBe(401);
      expect(JSON.stringify(await response.json())).not.toContain("rogier");
    });
  });
});

describe("the order of the checks", () => {
  it("checks the credential before the body: a malformed body without a credential gets 401", async () => {
    await withServer(async ({ base }) => {
      const bearer = await completeSetup(base);

      const anonymous = await post(base, "/api/v1/user/password", { nonsense: true });
      expect(anonymous.status).toBe(401);

      const authenticated = await post(base, "/api/v1/user/password", { nonsense: true }, bearer);
      expect(authenticated.status).toBe(400);
      const body = (await authenticated.json()) as {
        error: { code: string; details: { issues: ReadonlyArray<unknown> } };
      };
      expect(body.error.code).toBe("validation");
      expect(body.error.details.issues.length).toBeGreaterThan(0);
    });
  });

  it("returns the envelope, not an empty body, for a path no operation owns", async () => {
    await withServer(async ({ base }) => {
      const response = await fetch(`${base}/`);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    });
  });
});

describe("API keys over the wire", () => {
  it("mints a key, lists it without its token, uses it, and revokes it", async () => {
    await withServer(async ({ base, audit }) => {
      const bearer = await completeSetup(base);

      const minted = await post(base, "/api/v1/api-keys", { name: "laptop" }, bearer);
      expect(minted.status).toBe(200);
      const key = (await minted.json()) as { id: string; name: string; token: string };
      expect(key.name).toBe("laptop");

      const listed = await get(base, "/api/v1/api-keys", bearer);
      expect(listed.status).toBe(200);
      const page = (await listed.json()) as { items: ReadonlyArray<Record<string, unknown>> };
      expect(page.items).toHaveLength(1);
      expect(page.items[0]).toMatchObject({ id: key.id, name: "laptop" });
      expect(JSON.stringify(page)).not.toContain(key.token);

      // The key authenticates on its own, without the login token.
      expect((await get(base, "/api/v1/api-keys", key.token)).status).toBe(200);

      const revoked = await del(base, `/api/v1/api-keys/${key.id}`, bearer);
      expect(revoked.status).toBe(200);
      expect((await get(base, "/api/v1/api-keys", key.token)).status).toBe(401);

      const again = await del(base, `/api/v1/api-keys/${key.id}`, bearer);
      expect(again.status).toBe(404);

      expect(await audit("auth.apiKey.minted")).toMatchObject([
        { actor: "user", payload: { id: key.id, name: "laptop" } },
      ]);
      expect(await audit("auth.apiKey.revoked")).toMatchObject([
        { actor: "user", payload: { id: key.id } },
      ]);
    });
  });

  it("rejects an id that is not a canonical UUID before looking for a key", async () => {
    await withServer(async ({ base }) => {
      const bearer = await completeSetup(base);
      const response = await del(base, "/api/v1/api-keys/not-an-id", bearer);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
    });
  });
});

describe("changing the password over the wire", () => {
  it("accepts the new password afterwards and rejects the old one", async () => {
    await withServer(async ({ base, audit }) => {
      const bearer = await completeSetup(base);
      const next = "an entirely different passphrase";

      const wrong = await post(base, "/api/v1/user/password", { current: "guess", next }, bearer);
      expect(wrong.status).toBe(400);
      expect(await wrong.json()).toMatchObject({
        error: { code: "validation", details: { issues: [{ path: ["current"] }] } },
      });

      const changed = await post(
        base,
        "/api/v1/user/password",
        { current: PASSWORD, next },
        bearer,
      );
      expect(changed.status).toBe(200);

      const old = await post(base, "/api/v1/auth/login", {
        username: USERNAME,
        password: PASSWORD,
      });
      expect(old.status).toBe(401);
      const fresh = await post(base, "/api/v1/auth/login", { username: USERNAME, password: next });
      expect(fresh.status).toBe(200);

      // The credentials issued under the old password still work: changing a
      // password does not mean it was compromised, so nothing is revoked.
      expect((await get(base, "/api/v1/api-keys", bearer)).status).toBe(200);

      expect(await audit("user.passwordChanged")).toMatchObject([{ actor: "user", payload: {} }]);
      expect(await audit("setup.completed")).toMatchObject([{ actor: "user" }]);
      expect(await audit("auth.login.succeeded")).toHaveLength(1);
      expect(await audit("auth.login.failed")).toMatchObject([
        { actor: null, payload: { username: USERNAME } },
      ]);
    });
  });
});

describe("stopping", () => {
  it("stops accepting once the scope closes, so the port is free again", async () => {
    let base = "";
    await withServer(async ({ base: address }) => {
      base = address;
      expect((await fetch(`${base}/api/v1/setup`)).status).toBe(200);
    });

    await expect(fetch(`${base}/api/v1/setup`)).rejects.toThrow();
  });
});

describe("the pre-setup gate checks the operation, not the raw path", () => {
  it("gates a path the router matches case-insensitively", async () => {
    await withServer(async ({ base, audit }) => {
      const response = await post(base, "/API/v1/AUTH/LOGIN", {
        username: USERNAME,
        password: PASSWORD,
      });

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: {
          code: "unauthenticated",
          message: expect.stringContaining("not set up") as string,
        },
      });
      // The operation never ran: no argon2 verify, no row in the event log.
      expect(await audit("auth.login.failed")).toEqual([]);
    });
  });

  it("gates a path the router reaches through a doubled slash", async () => {
    await withServer(async ({ base }) => {
      const response = await get(base, "//api/v1/secrets", "looks-like-a-token");

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { message: expect.stringContaining("not set up") as string },
      });
    });
  });

  it("returns 404 for a path no operation owns, both before and after setup", async () => {
    await withServer(async ({ base }) => {
      const before = await get(base, "/api/v1/nothing-here");
      expect(before.status).toBe(404);
      expect(await before.json()).toMatchObject({ error: { code: "not_found" } });

      await completeSetup(base);
      expect((await get(base, "/api/v1/nothing-here")).status).toBe(404);
    });
  });
});

describe("the body size limit", () => {
  /**
   * The limit belongs to the listener, so the error is the transport's bare
   * `413`, the only response outside the error envelope. It happens before the
   * body is read, which is why nothing reaches the audit log.
   */
  it("rejects a body over the limit with a 413, without storing it", async () => {
    await withServer(async ({ base, audit }) => {
      const username = "x".repeat(MAX_REQUEST_BODY_BYTES + 1);
      const response = await post(base, "/api/v1/auth/login", { username, password: PASSWORD });

      expect(response.status).toBe(413);
      expect(await audit("auth.login.failed")).toEqual([]);
    });
  });

  it("refuses a body sent without a length with a 411, except an image upload", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const chunked = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: streamBody(new TextEncoder().encode("{}")),
      });
      expect(chunked.status).toBe(411);

      const upload = await fetch(`${base}/api/v1/attachments?name=a.png`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", authorization: `Bearer ${token}` },
        body: streamBody(PNG_SIGNATURE),
      });
      expect(upload.status, await upload.clone().text()).toBe(201);
    });
  });

  it("refuses an image upload sent without a length once it passes the upload limit", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const bytes = new Uint8Array(MAX_UPLOAD_BODY_BYTES + 1);
      bytes.set(PNG_SIGNATURE);
      const response = await fetch(`${base}/api/v1/attachments?name=big.png`, {
        method: "POST",
        headers: { "content-type": "application/octet-stream", authorization: `Bearer ${token}` },
        body: streamBody(bytes),
      });

      expect(response.status).toBe(413);
    });
  });

  it("takes an image upload up to the upload limit, which is above the general one", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const bytes = new Uint8Array(MAX_UPLOAD_BODY_BYTES);
      bytes.set(PNG_SIGNATURE);
      const response = await uploadBytes(base, token, "/api/v1/attachments?name=big.png", bytes);

      expect(response.status, await response.clone().text()).toBe(201);
      expect(await response.json()).toMatchObject({ sizeBytes: MAX_UPLOAD_BODY_BYTES });
    });
  });

  it("holds only the exact upload path to the upload limit, not a look-alike", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const bytes = new Uint8Array(MAX_REQUEST_BODY_BYTES + 1);
      bytes.set(PNG_SIGNATURE);

      const lookAlike = await uploadBytes(base, token, "/api/v1/Attachments?name=a.png", bytes);
      expect(lookAlike.status).toBe(413);
    });
  });

  /**
   * The limit runs before the route checks the runner's credential, so a
   * `401` rather than a `411` or `413` shows the request passed the limit.
   */
  it("holds a runner's upload of a tool result's attachment to the upload limit too, at its exact path only", async () => {
    await withServer(async ({ base }) => {
      const chunked = await fetch(`${base}${RUNNER_ATTACHMENTS_PATH}?sessionId=x`, {
        method: "POST",
        headers: { authorization: "Bearer a-made-up-credential" },
        body: streamBody(PNG_SIGNATURE),
      });
      expect(chunked.status).toBe(401);

      const bytes = new Uint8Array(MAX_REQUEST_BODY_BYTES + 1);
      bytes.set(PNG_SIGNATURE);
      const lookAlike = await uploadBytes(
        base,
        "a-made-up-credential",
        `${RUNNER_ATTACHMENTS_PATH.toUpperCase()}?sessionId=x`,
        bytes,
      );
      expect(lookAlike.status).toBe(413);
    });
  });
});

describe("a body of the wrong type", () => {
  it("names raw bytes for an image upload, and JSON everywhere else", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const upload = await fetch(`${base}/api/v1/attachments?name=a.png`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: "{}",
      });
      const login = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "not json",
      });

      expect(upload.status).toBe(400);
      expect(await upload.json()).toMatchObject({
        error: {
          code: "validation",
          details: { issues: [{ message: "the request body must be application/octet-stream" }] },
        },
      });
      expect(await login.json()).toMatchObject({
        error: { details: { issues: [{ message: "the request body must be application/json" }] } },
      });
    });
  });
});

describe("a body that is not JSON", () => {
  it("gets an error in the envelope rather than a bare 415", async () => {
    await withServer(async ({ base }) => {
      await completeSetup(base);
      const response = await fetch(`${base}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "not json",
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
    });
  });
});

describe("recording a credential's use", () => {
  it("writes once for a burst of requests, not once per request", async () => {
    await withServer(async ({ base }) => {
      const bearer = await completeSetup(base);
      const minted = await post(base, "/api/v1/api-keys", { name: "laptop" }, bearer);
      const key = (await minted.json()) as { id: string; token: string };

      const readLastUsedAt = async (): Promise<string | null> => {
        const page = (await (await get(base, "/api/v1/api-keys", bearer)).json()) as {
          items: ReadonlyArray<{ id: string; lastUsedAt: string | null }>;
        };
        return page.items.find((item) => item.id === key.id)?.lastUsedAt ?? null;
      };

      expect((await get(base, "/api/v1/api-keys", key.token)).status).toBe(200);
      const first = await readLastUsedAt();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect((await get(base, "/api/v1/api-keys", key.token)).status).toBe(200);

      expect(await readLastUsedAt()).toBe(first);
    });
  });
});

/** The eight bytes every PNG file starts with, which is all the controller checks. */
const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Returns `bytes` as a stream, in chunks of 1 MiB. A stream body makes fetch
 * send it with `Transfer-Encoding: chunked` and no `content-length`.
 */
const streamBody = (bytes: Uint8Array): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += 1024 * 1024)
        controller.enqueue(bytes.subarray(offset, offset + 1024 * 1024));
      controller.close();
    },
  });

/** Sends `bytes` as the raw body of a POST to `path`, as an image upload does. */
const uploadBytes = (
  base: string,
  token: string,
  path: string,
  bytes: Uint8Array,
): Promise<Response> =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream", authorization: `Bearer ${token}` },
    body: bytes,
  });
