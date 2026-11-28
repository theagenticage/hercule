/**
 * The fake OAuth provider that the controller's tests of Connections and MCP
 * Servers talk to, so every test agrees on what a provider does. It plays the
 * two endpoints the `oauth/` leaf calls: the token endpoint (code exchange,
 * refresh with rotating refresh tokens, device-code polling, refusals) and
 * the device code endpoint (RFC 8628). It never calls a real vendor.
 *
 * Two ways to host it:
 *
 * - `startFakeOAuthProvider` listens on its own loopback port, for tests whose
 *   plugin points its token URL at `provider.base`.
 * - `createFakeOAuthProvider` listens on nothing and gives a `handle` function,
 *   for a fake that serves the provider's endpoints on a server it already
 *   has (the fake MCP server, whose origin is also its authorization server's).
 */

/** The path of the device code endpoint. */
const DEVICE_CODE_PATH = "/device/code";

/** The provider's device code, which only the controller sends back. */
export const DEVICE_CODE = "the-device-code";

/** The form body of one request to the token endpoint. */
export type TokenForm = Record<string, string>;

/**
 * An answer of the token endpoint. A test replaces one to make the provider
 * refuse, fail, or hold the request in flight by returning a promise it
 * settles later.
 */
export type TokenAnswer = (form: TokenForm, request: Request) => Response | Promise<Response>;

/** What `FakeOAuthProvider.issueTokens` may be asked for. */
export interface IssueTokensOptions {
  /** Whether the answer carries a refresh token. By default it does. */
  readonly refreshToken?: boolean;
}

/** An in-test OAuth provider. */
export interface FakeOAuthProvider {
  /** The path of the token endpoint. A test changes it to move the endpoint. */
  tokenPath: string;
  /** Every form body posted to the token endpoint, in order. */
  readonly tokenRequests: ReadonlyArray<TokenForm>;
  /** Every form body posted to the device code endpoint, in order. */
  readonly codeRequests: ReadonlyArray<TokenForm>;
  /** The OAuth error codes `refuse` returned, in order. */
  readonly tokenErrorCodes: ReadonlyArray<string>;
  /**
   * The next answers of the two endpoints, which a test can replace. A token
   * request gets `byGrant[grant_type]`, or `token` when that grant has no
   * entry. By default the device code endpoint issues a code with a
   * five-second interval, and `token` answers that the user has not approved
   * yet.
   */
  readonly answers: {
    code: () => Response;
    token: TokenAnswer;
    readonly byGrant: Record<string, TokenAnswer>;
  };
  /**
   * Runs before the answer to every token request, and returns the response
   * that refuses it, or `undefined` to let the answer go ahead. A test sets it
   * for a rule every answer must respect, such as what a client may send.
   */
  vetRequest: ((form: TokenForm, request: Request) => Response | undefined) | undefined;
  /** The `expires_in`, in seconds, of every access token `issueTokens` issues. */
  expiresIn: number;
  /**
   * The `expires_in` of the first access token `issueTokens` issues, when it
   * differs from `expiresIn`. A test makes it 0 to get a token that is stale
   * at once, while the refreshed tokens last.
   */
  firstExpiresIn: number | undefined;
  /** The `token_type` of every access token `issueTokens` issues. */
  tokenType: string;
  /** When set, every refresh is refused with `refreshErrorCode`. */
  refuseRefresh: boolean;
  /** The OAuth error code returned when `refuseRefresh` is true. */
  refreshErrorCode: string;
  /** Issues a new access token and, unless asked not to, a new refresh token, and remembers both. */
  issueTokens: (options?: IssueTokensOptions) => Response;
  /**
   * Answers a refresh as a rotating provider does: the refresh token of the
   * form must be one `issueTokens` issued and it dies at once, and the answer
   * carries new tokens. Any other refresh token is refused `invalid_grant`.
   */
  rotateRefreshToken: (form: TokenForm) => Response;
  /** Builds an OAuth error response and records its code in `tokenErrorCodes`. */
  refuse: (error: string, status?: number) => Response;
  /** Whether an `Authorization` header carries an access token that was issued and not revoked. */
  accepts: (authorization: string | null) => boolean;
  /** The access token issued last. */
  currentAccessToken: () => string;
  /** Makes `accepts` refuse every access token issued so far, as a provider that revoked them does. */
  revokeAccessTokens: () => void;
  /**
   * Answers a request of the token endpoint or the device code endpoint, or
   * returns `undefined` for any other request.
   */
  handle: (request: Request) => Promise<Response | undefined>;
  /** Whether `stop` was called. */
  stopped: boolean;
  /**
   * Makes both endpoints answer HTTP 503, as a provider that is down. A
   * provider that listens on its own port also closes it. Calling it again
   * does nothing, so a test may stop the provider to simulate an unreachable
   * one and the harness stop it again afterwards.
   */
  stop: () => Promise<void>;
}

/** A provider that listens on a port of its own. */
export interface ListeningFakeOAuthProvider extends FakeOAuthProvider {
  /** The origin the type's `deviceCodeUrl` and `tokenUrl` are built from. */
  readonly base: string;
}

/** Creates a provider that serves its endpoints through `handle` and listens on nothing. */
export const createFakeOAuthProvider = (): FakeOAuthProvider => {
  const tokenRequests: Array<TokenForm> = [];
  const codeRequests: Array<TokenForm> = [];
  const tokenErrorCodes: Array<string> = [];
  const refreshTokens = new Set<string>();
  let accessTokens = new Set<string>();
  let issued = 0;
  let lastAccessToken = "";

  const refuse = (error: string, status = 400) => {
    tokenErrorCodes.push(error);
    return Response.json({ error }, { status });
  };

  const issueTokens = (options: IssueTokensOptions = {}): Response => {
    issued += 1;
    lastAccessToken = `access-token-${String(issued)}`;
    accessTokens.add(lastAccessToken);
    const includeRefreshToken = options.refreshToken ?? true;
    const refreshToken = `refresh-token-${String(issued)}`;
    if (includeRefreshToken) refreshTokens.add(refreshToken);
    return Response.json({
      access_token: lastAccessToken,
      ...(includeRefreshToken ? { refresh_token: refreshToken } : {}),
      token_type: fake.tokenType,
      expires_in: issued === 1 ? (fake.firstExpiresIn ?? fake.expiresIn) : fake.expiresIn,
    });
  };

  const fake: FakeOAuthProvider = {
    tokenPath: "/token",
    tokenRequests,
    codeRequests,
    tokenErrorCodes,
    answers: {
      code: () =>
        Response.json({
          device_code: DEVICE_CODE,
          user_code: "WDJB-MJHT",
          verification_uri: "https://provider.test/device",
          expires_in: 900,
          interval: 5,
        }),
      // Providers such as GitHub answer 200 with an error in the body while the user has not approved.
      token: () => Response.json({ error: "authorization_pending" }),
      byGrant: {},
    },
    vetRequest: undefined,
    expiresIn: 3600,
    firstExpiresIn: undefined,
    tokenType: "Bearer",
    refuseRefresh: false,
    refreshErrorCode: "invalid_grant",
    issueTokens,
    rotateRefreshToken: (form) => {
      const token = form["refresh_token"] ?? "";
      if (!refreshTokens.has(token)) return refuse("invalid_grant");
      refreshTokens.delete(token);
      return issueTokens();
    },
    refuse,
    accepts: (authorization) =>
      authorization !== null &&
      authorization.startsWith("Bearer ") &&
      accessTokens.has(authorization.slice("Bearer ".length)),
    currentAccessToken: () => lastAccessToken,
    revokeAccessTokens: () => {
      accessTokens = new Set();
    },
    handle: async (request) => {
      const url = new URL(request.url);
      const isToken = url.pathname === fake.tokenPath && request.method === "POST";
      if (!isToken && url.pathname !== DEVICE_CODE_PATH) return undefined;
      if (fake.stopped) return new Response("down", { status: 503 });
      const form: TokenForm = Object.fromEntries(new URLSearchParams(await request.text()));
      if (!isToken) {
        codeRequests.push(form);
        return fake.answers.code();
      }
      tokenRequests.push(form);
      const grant = form["grant_type"] ?? "";
      if (grant === "refresh_token" && fake.refuseRefresh) return refuse(fake.refreshErrorCode);
      const refusal = fake.vetRequest?.(form, request);
      if (refusal !== undefined) return refusal;
      return (fake.answers.byGrant[grant] ?? fake.answers.token)(form, request);
    },
    stopped: false,
    stop: () => {
      fake.stopped = true;
      return Promise.resolve();
    },
  };
  return fake;
};

/** Starts a provider on a free port of the loopback address. Stop it when the test ends. */
export const startFakeOAuthProvider = (): ListeningFakeOAuthProvider => {
  const provider = createFakeOAuthProvider();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (request) =>
      (await provider.handle(request)) ?? new Response("not here", { status: 404 }),
  });
  const markStopped = provider.stop;
  let closed = false;
  return Object.assign(provider, {
    base: `http://127.0.0.1:${server.port}`,
    stop: async () => {
      await markStopped();
      if (closed) return;
      closed = true;
      await server.stop(true);
    },
  });
};

/**
 * Builds an answer of the token endpoint whose body never ends, `chunkBytes`
 * at a time, with the given status and headers. `wasCancelled` tells whether
 * the client cancelled a body, which a client that bounds what it reads does.
 */
export const buildEndlessBodyAnswer = (
  init: { readonly status: number; readonly headers?: Record<string, string> },
  chunkBytes = 1,
): { readonly answer: TokenAnswer; readonly wasCancelled: () => boolean } => {
  let cancelled = false;
  const chunk = new Uint8Array(chunkBytes);
  return {
    answer: () => {
      let timer: ReturnType<typeof setInterval> | undefined;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(chunk);
            timer = setInterval(() => controller.enqueue(chunk), 20);
          },
          cancel() {
            cancelled = true;
            clearInterval(timer);
          },
        }),
        init,
      );
    },
    wasCancelled: () => cancelled,
  };
};
