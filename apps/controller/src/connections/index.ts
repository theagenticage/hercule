/**
 * Connections: the external accounts Hercule acts through. The core owns the
 * connection record and its credentials; each connection type comes from a
 * plugin.
 */
export { PluginConfigs } from "./plugin-configs";
export {
  connectionRepository,
  GITHUB_CONNECTION_TYPE,
  isGithubConnection,
  type StoredConnection,
} from "./repository";
export { OAuthCallbackRouteLayer } from "./route";
export { ConnectionTypes, ConnectionTypesLayer, type RegisteredConnectionType } from "./runtime";
export {
  ConnectionService,
  ConnectionServiceLayer,
  type ConnectionPage,
  type CredentialsInput,
  type QueryInput,
  type UpdateInput,
} from "./service";
