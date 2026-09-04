/**
 * The controller's listener, end to end over a real socket: the order the gates
 * run in, the envelope on every failure, and the operations a request reaches.
 *
 * The stack, the temporary home and the request helpers are `./testing.ts`,
 * which is the same one every other transport test drives.
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
import { MAX_REQUEST_BODY_BYTES } from "./server";

describe("before setup completes", () => {
  it("answers setup.read unauthenticated, so the web app knows where to route", async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/api/v1/setup`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ complete: false });
    });
  });

  it("answers every other operation 401, credential or not", async () => {
    await withServer(async (base) => {
      const anonymous = await fetch(`${base}/api/v1/settings`);
      const withBearer = await fetch(`${base}/api/v1/settings`, {
        headers: { authorization: "Bearer looks-like-a-token" },
      });

      expect(anonymous.status).toBe(401);
      expect(withBearer.status).toBe(401);
      expect(await anonymous.json()).toMatchObject({ error: { code: "unauthenticated" } });
    });
  });

  it("answers login 401 as well: there is no user to log in as yet", async () => {
    await withServer(async (base) => {
      const response = await post(base, "/api/v1/auth/login", {
        username: USERNAME,
        password: PASSWORD,
      });
      expect(response.status).toBe(401);
    });
  });

  it("refuses setup.complete without the setup token, and with the wrong one", async () => {
    await withServer(async (base) => {
      const input = { username: USERNAME, password: PASSWORD, timezone: "Europe/Amsterdam" };
      expect((await post(base, "/api/v1/setup/complete", input)).status).toBe(401);
      expect((await post(base, "/api/v1/setup/complete", input, "wrong")).status).toBe(401);
    });
  });
});

describe("setup, login and logout", () => {
  it("completes setup once, and says so afterwards", async () => {
    await withServer(async (base) => {
      const token = await completeSetup(base);
      expect(token).not.toBe("");

      expect(await (await fetch(`${base}/api/v1/setup`)).json()).toEqual({ complete: true });

      const again = await post(
        base,
        "/api/v1/setup/complete",
        { username: "someone", password: PASSWORD, timezone: "UTC" },
        SETUP_TOKEN,
      );
      // The token is spent, so the gate answers before the state does.
      expect(again.status).toBe(401);
    });
  });

  it("logs in with the password and logs out again, and the token dies with it", async () => {
    await withServer(async (base) => {
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

  it("answers a wrong password 401 without saying which half was wrong", async () => {
    await withServer(async (base) => {
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
  it("answers 401 before 400: a malformed body under no credential is unauthenticated", async () => {
    await withServer(async (base) => {
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

  it("answers a path no operation owns with the envelope, not an empty body", async () => {
    await withServer(async (base) => {
      const response = await fetch(`${base}/`);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ error: { code: "not_found" } });
    });
  });
});

describe("API keys over the wire", () => {
  it("mints a key, lists it without its token, uses it, and revokes it", async () => {
    await withServer(async (base, audit) => {
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

      // The key authenticates in its own right, without the login bearer.
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

  it("refuses an id that is not a canonical uuid before it looks for a key", async () => {
    await withServer(async (base) => {
      const bearer = await completeSetup(base);
      const response = await del(base, "/api/v1/api-keys/not-an-id", bearer);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "validation" } });
    });
  });
});

describe("changing the password over the wire", () => {
  it("takes the new password afterwards and refuses the old one", async () => {
    await withServer(async (base, audit) => {
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

      // The credentials issued under the old password still work: a rotation
      // is not a compromise, so nothing is revoked.
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
    await withServer(async (address) => {
      base = address;
      expect((await fetch(`${base}/api/v1/setup`)).status).toBe(200);
    });

    await expect(fetch(`${base}/api/v1/setup`)).rejects.toThrow();
  });
});

describe("the pre-setup gate decides on the operation, not on the path", () => {
  it("gates a path the router matches case-insensitively", async () => {
    await withServer(async (base, audit) => {
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
    await withServer(async (base) => {
      const response = await get(base, "//api/v1/secrets", "looks-like-a-token");

      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({
        error: { message: expect.stringContaining("not set up") as string },
      });
    });
  });

  it("answers a path no operation owns 404, before setup as after it", async () => {
    await withServer(async (base) => {
      const before = await get(base, "/api/v1/nothing-here");
      expect(before.status).toBe(404);
      expect(await before.json()).toMatchObject({ error: { code: "not_found" } });

      await completeSetup(base);
      expect((await get(base, "/api/v1/nothing-here")).status).toBe(404);
    });
  });
});

describe("the body cap", () => {
  /**
   * The cap is the listener's, so the refusal is the transport's bare `413` -
   * the one response outside the error envelope - and it lands before the body
   * is read, which is why nothing reaches the audit log.
   */
  it("refuses a body larger than the cap with a 413, without storing it", async () => {
    await withServer(async (base, audit) => {
      const username = "x".repeat(MAX_REQUEST_BODY_BYTES + 1);
      const response = await post(base, "/api/v1/auth/login", { username, password: PASSWORD });

      expect(response.status).toBe(413);
      expect(await audit("auth.login.failed")).toEqual([]);
    });
  });
});

describe("a body that is not JSON", () => {
  it("answers in the envelope rather than a bare 415", async () => {
    await withServer(async (base) => {
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

describe("stamping a credential's use", () => {
  it("writes once for a burst of requests, not once per request", async () => {
    await withServer(async (base) => {
      const bearer = await completeSetup(base);
      const minted = await post(base, "/api/v1/api-keys", { name: "laptop" }, bearer);
      const key = (await minted.json()) as { id: string; token: string };

      const stampOf = async (): Promise<string | null> => {
        const page = (await (await get(base, "/api/v1/api-keys", bearer)).json()) as {
          items: ReadonlyArray<{ id: string; lastUsedAt: string | null }>;
        };
        return page.items.find((item) => item.id === key.id)?.lastUsedAt ?? null;
      };

      expect((await get(base, "/api/v1/api-keys", key.token)).status).toBe(200);
      const first = await stampOf();
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect((await get(base, "/api/v1/api-keys", key.token)).status).toBe(200);

      expect(await stampOf()).toBe(first);
    });
  });
});
