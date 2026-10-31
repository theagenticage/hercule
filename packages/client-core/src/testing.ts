/**
 * The test helpers the apps import as `@hercule/client-core/testing`: a fake
 * controller API played at `fetch`, a fake live socket, and the providers,
 * harnesses and Provider Accounts the plugins' shipped definitions give.
 * No app code imports them.
 */
export { buildErrorBody, createApiStub, type Answer, type Call, type Handler } from "./api-stub";
export {
  STUB_SERVER_VERSION,
  StubSocket,
  stubWebSocketInto,
  type Frame,
  type StubSubscription,
} from "./live/socket-stub";
export {
  ANTHROPIC_API_KEY_IDENTITY,
  ANTHROPIC_IDENTITY,
  HARNESSES,
  HARNESSES_WITH_ANTHROPIC_API_KEY,
  OPENAI_IDENTITY,
  PROVIDERS,
  PROVIDERS_WITH_ANTHROPIC_API_KEY,
  WITH_CLAUDE,
  WITH_CLAUDE_AND_PI,
  ZAI_IDENTITY,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
  buildProviderAccount,
  buildSnapshot,
  type ProviderAccountIdentity,
} from "./providers.testing";
