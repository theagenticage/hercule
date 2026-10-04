/**
 * Connections: the external accounts Hercule acts through. The core owns the
 * connection record and its credentials; each connection type comes from a
 * plugin.
 */
export { githubTokens, type GithubToken } from "./github";
export { OAUTH_TOKENS } from "./oauth";
export { PluginConfigs } from "./plugin-configs";
export { ConnectionReferences, type ConnectionReference } from "./references";
export {
  connectionRepository,
  GITHUB_CONNECTION_TYPE,
  isGithubConnection,
  type StoredConnection,
} from "./repository";
export { OAuthCallbackRouteLayer } from "./route";
export {
  ConnectionTypes,
  ConnectionTypesLayer,
  type FeedSource,
  type RegisteredConnectionType,
} from "./runtime";
export {
  ConnectionService,
  ConnectionServiceLayer,
  type ConnectionPage,
  type CredentialsInput,
  type QueryInput,
  type UpdateInput,
} from "./service";
