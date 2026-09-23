/**
 * Tests paging and sorting over a real socket.
 *
 * A service-level test cannot check these, because each one is about what
 * survives the trip through a URL query:
 *
 * - `sort` arrives at all;
 * - an unknown sort field is rejected rather than ignored;
 * - a cursor from somewhere else is a `validation` error, not a page with a
 *   meaningless boundary.
 */
import { describe, expect, it } from "vitest";
import { completeSetup, post, send, withServer } from "./testing";

/** Returns the listing's names, in the order the server returned them. */
const listApiKeyNames = async (
  base: string,
  token: string,
  query: string,
): Promise<Array<string>> => {
  const response = await send("GET", base, `/api/v1/api-keys${query}`, { token });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { items: ReadonlyArray<{ name: string }> };
  return body.items.map((item) => item.name);
};

/** Returns a listing's next cursor, or `undefined` on the last page. */
const readNextCursor = async (base: string, token: string, path: string): Promise<string> => {
  const response = await send("GET", base, path, { token });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { nextCursor?: string };
  if (body.nextCursor === undefined) throw new Error(`${path} handed back no cursor`);
  return body.nextCursor;
};

/** Returns the error envelope's code, whatever the status was. */
const readErrorCode = async (response: Response): Promise<string> =>
  ((await response.json()) as { error?: { code?: string } }).error?.code ?? "no envelope";

/** Mints three API keys in order, so a listing has something to sort. */
const mintThreeKeys = async (base: string, token: string): Promise<void> => {
  for (const name of ["a", "b", "c"]) {
    const minted = await post(base, "/api/v1/api-keys", { name }, token);
    expect(minted.status).toBe(200);
  }
};

describe("sort over the wire", () => {
  it("reverses the default order when asked, and rejects a field it cannot sort on", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      await mintThreeKeys(base, token);

      // Newest first is the default for credentials; `sort` must be able to
      // change it, visibly.
      expect(await listApiKeyNames(base, token, "")).toEqual(["c", "b", "a"]);
      expect(await listApiKeyNames(base, token, "?sort=createdAt:asc")).toEqual(["a", "b", "c"]);
      expect(await listApiKeyNames(base, token, "?sort=createdAt:desc")).toEqual(["c", "b", "a"]);
      // No direction: the service's default applies, and the request does not
      // fail.
      expect(await listApiKeyNames(base, token, "?sort=createdAt")).toEqual(["c", "b", "a"]);

      const unknownField = await send("GET", base, "/api/v1/api-keys?sort=bogus:asc", { token });
      expect(unknownField.status).toBe(400);
      expect(await readErrorCode(unknownField)).toBe("validation");

      const unknownDirection = await send("GET", base, "/api/v1/api-keys?sort=createdAt:sideways", {
        token,
      });
      expect(unknownDirection.status).toBe(400);
      expect(await readErrorCode(unknownDirection)).toBe("validation");
    });
  });

  it("sorts the secrets listing both ways", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      for (const name of ["alpha", "beta"]) {
        const stored = await send("PUT", base, `/api/v1/secrets/plugin/p1/${name}`, {
          body: { value: "v" },
          token,
        });
        expect(stored.status).toBe(200);
      }
      const listSecretNames = async (query: string): Promise<Array<string>> => {
        const response = await send("GET", base, `/api/v1/secrets?ownerKind=plugin${query}`, {
          token,
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as { items: ReadonlyArray<{ name: string }> };
        return body.items.map((item) => item.name);
      };
      expect(await listSecretNames("")).toEqual(["alpha", "beta"]);
      expect(await listSecretNames("&sort=name:desc")).toEqual(["beta", "alpha"]);
    });
  });
});

describe("a cursor that is not this listing's", () => {
  /** A cursor the old, looser cursor check let through, which then caused a 500. */
  const dashes = Buffer.from(JSON.stringify(["x", "-".repeat(36)]), "utf8").toString("base64url");

  it("is a validation error, not a crash", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      for (const path of ["/api/v1/api-keys", "/api/v1/secrets", "/api/v1/profiles"]) {
        const response = await send("GET", base, `${path}?cursor=${dashes}`, { token });
        expect(response.status, path).toBe(400);
        expect(await readErrorCode(response), path).toBe("validation");
      }
    });
  });

  it("is rejected when it came from another listing", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      await mintThreeKeys(base, token);
      const stored = await send("PUT", base, "/api/v1/secrets/plugin/p1/alpha", {
        body: { value: "v" },
        token,
      });
      expect(stored.status).toBe(200);
      // Two secrets now, and three built-in profiles, so both listings have a
      // second page at limit 1.
      const fromSecrets = await readNextCursor(base, token, "/api/v1/secrets?limit=1");
      const fromProfiles = await readNextCursor(base, token, "/api/v1/profiles?limit=1");

      for (const cursor of [fromSecrets, fromProfiles]) {
        const response = await send("GET", base, `/api/v1/api-keys?cursor=${cursor}`, { token });
        expect(response.status).toBe(400);
        expect(await readErrorCode(response)).toBe("validation");
      }
    });
  });

  it("is rejected when it was issued under a different sort", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      await mintThreeKeys(base, token);
      const descending = await readNextCursor(base, token, "/api/v1/api-keys?limit=1");

      const replayed = await send(
        "GET",
        base,
        `/api/v1/api-keys?limit=1&sort=createdAt:asc&cursor=${descending}`,
        { token },
      );
      expect(replayed.status).toBe(400);
      expect(await readErrorCode(replayed)).toBe("validation");

      // The same cursor still works with the sort that issued it.
      expect(await listApiKeyNames(base, token, `?limit=1&cursor=${descending}`)).toEqual(["b"]);
    });
  });
});

describe("bounds on what a caller may send", () => {
  it("rejects a huge username before it can be authenticated or audited", async () => {
    await withServer(async ({ base, audit }) => {
      await completeSetup(base);
      const response = await post(base, "/api/v1/auth/login", {
        username: "x".repeat(20_000),
        password: "correct horse battery staple",
      });
      // 400, not 401: the request never reached the credential check, so the
      // username was not written into the log, which is kept for 90 days.
      expect(response.status).toBe(400);
      expect(await readErrorCode(response)).toBe("validation");
      expect(await audit("auth.login.failed")).toHaveLength(0);
    });
  });
});
