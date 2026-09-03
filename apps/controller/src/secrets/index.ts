/**
 * Secrets: every secret value encrypted on its own under the Master Key, which
 * is created at first run and never leaves its machine (spec 13 section 2, ADR
 * 0015).
 */
export { masterKeyLayer, type MasterKeyBackend, type MasterKeyError } from "./masterKey";
export { CORE_OWNER, Secrets, secretsLayer, type SecretNameError } from "./repository";
