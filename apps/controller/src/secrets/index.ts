/**
 * Secrets: every secret value encrypted on its own under the Master Key, which
 * is created at first run and never leaves its machine. Outside this domain a
 * secret is only ever a reference.
 */
export { masterKeyLayer, type MasterKeyBackend, type MasterKeyError } from "./masterKey";
export {
  CORE_OWNER,
  Secrets,
  secretsLayer,
  type SecretNameError,
  type SecretNameRef,
  type SecretOwner,
  type SecretOwnerKind,
} from "./repository";
export {
  Secret,
  SecretLayer,
  type SecretDeleteInput,
  type SecretQueryInput,
  type SecretRefPage,
  type SecretSetInput,
} from "./service";
