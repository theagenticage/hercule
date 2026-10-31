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
  ANTHROPIC_IDENTITY,
  HARNESSES,
  OPENAI_IDENTITY,
  PROVIDERS,
  ZAI_IDENTITY,
  buildModelProfile,
  buildProfileEntry,
  buildProfileSection,
  buildProviderAccount,
  type ProviderAccountIdentity,
} from "./providers.testing";
