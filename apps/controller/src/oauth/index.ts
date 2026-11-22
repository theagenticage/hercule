/**
 * OAuth: what an OAuth2 client does that is not about one kind of owner. A
 * Connection and an MCP Server added by URL both use it, and it imports
 * neither: the token set and how it is stored, the requests to a token
 * endpoint, and the two generic halves of a refresh.
 */
export {
  computeChallenge,
  exchangeCode,
  isExpired,
  isStale,
  MAX_ANSWER_BYTES,
  parseTokens,
  postForm,
  readBoundedText,
  ProviderRefused,
  ProviderUnreachable,
  refreshAccess,
  requestTokens,
  serializeTokens,
  StoredTokensUnreadable,
  TOKEN_REQUEST_TIMEOUT_SECONDS,
  // Kept until oauth-sign-in.ts drops its own timeout, which `requestTokens` now makes.
  TOKEN_REQUEST_TIMEOUT_SECONDS as REFRESH_TIMEOUT_SECONDS,
  TokenSetSchema,
  type ClientAuthMethod,
  type OAuthClient,
  type TokenAnswer,
  type TokenSet,
} from "./client";
export {
  makeKeyedLocks,
  makeRefreshPermits,
  renewTokenSet,
  type KeyedLocks,
  type RefreshEndpoint,
  type RefreshPermits,
} from "./refresh";
