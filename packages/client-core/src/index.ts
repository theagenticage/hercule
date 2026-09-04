/**
 * `@hydra/client-core`: the public API as promises.
 *
 * The one client package that writes Effect code (ADR 0017, ADR 0031). The web
 * app and the CLI import `createClient` and see promises, plain objects, and
 * the two error classes below - nothing else.
 */
export {
  createClient,
  type ClientOptions,
  type FetchLike,
  type HydraClient,
  type Operations,
} from "./client";
export { ApiError, ConnectionError, type ErrorEnvelope } from "./errors";
