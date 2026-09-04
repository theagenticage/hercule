/**
 * Secrets: every secret value encrypted on its own under the Master Key, which
 * is created at first run and never leaves its machine (spec 13 section 2, ADR
 * 0015). Outside this domain a secret is only ever a reference.
 */
export { masterKeyLayer, type MasterKeyBackend, type MasterKeyError } from "./masterKey";
export {
  CORE_OWNER,
  Secrets,
  secretsLayer,
  type SecretNameError,
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
