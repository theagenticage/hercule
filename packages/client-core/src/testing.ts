/**
 * The test helpers the apps import as `@hercule/client-core/testing`: a fake
 * controller API played at `fetch`, and a fake live socket. No app code
 * imports them.
 */
export { buildErrorBody, createApiStub, type Answer, type Call, type Handler } from "./api-stub";
export {
  STUB_SERVER_VERSION,
  StubSocket,
  stubWebSocketInto,
  type Frame,
  type StubSubscription,
} from "./live/socket-stub";
