/**
 * Secrets: every secret value encrypted on its own under the Master Key, which
 * is created at first run and never leaves its machine. Outside this domain a
 * secret is only ever a reference.
 */
export { type SecretDecryptError } from "./cipher";
export {
  MasterKey,
  masterKeyLayer,
  createMasterKey,
  defaultBackend,
  openExistingMasterKey,
  openKeyStore,
  type MasterKeyBackend,
  type MasterKeyError,
  type SecurityRunner,
} from "./masterKey";
export {
  CORE_OWNER,
  buildProviderAccountOwner,
  Secrets,
  secretsLayer,
  type SecretNameError,
  type SecretNameRef,
  type SecretOwner,
  type SecretOwnerKind,
} from "./repository";
export { rewrapSecrets } from "./rewrap";
export {
  Secret,
  SecretLayer,
  type SecretDeleteInput,
  type SecretQueryInput,
  type SecretRefPage,
  type SecretSetInput,
} from "./service";
