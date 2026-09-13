/**
 * Connections: the external accounts Hydra acts through. The record and its
 * credentials are core-owned; the types are plugin contributions.
 */
export { PluginConfigs } from "./plugin-configs";
export { OAuthCallbackRouteLayer } from "./route";
export { ConnectionTypes, ConnectionTypesLayer, type RegisteredConnectionType } from "./runtime";
export {
  ConnectionService,
  ConnectionServiceLayer,
  type ConnectionPage,
  type CredentialsInput,
  type Identified,
  type QueryInput,
  type UpdateInput,
} from "./service";
