/**
 * Provider instances: a registered provider plus the config it runs under.
 *
 * This is the one domain that still sends frames to runners itself - logging a
 * provider in, probing a machine, installing a harness - rather than handing
 * them to the controller daemon. There is no cycle in it, so it was left where
 * it is; bringing it under the same rule is issue #209.
 */
export { ensureProviderInstances } from "./defaults";
export {
  ProviderProbes,
  ProviderProbesLayer,
  ProviderProbeDeadline,
  ProviderProbeInterval,
} from "./probes";
export { providerRepository, type StoredSnapshot } from "./repository";
export { loggedIn, NO_PLACEMENT, resolvedInstance } from "./resolved";
export {
  ProviderLoginDeadline,
  ProviderService,
  ProviderServiceLayer,
  type Identified,
  type UpdateInput,
} from "./service";
