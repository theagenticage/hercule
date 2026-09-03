/** The Master Key: created at first run, never leaves its machine (spec 13 section 2.2). */
export {
  defaultBackend,
  fileStore,
  KEYCHAIN_SERVICE,
  keychainStore,
  MASTER_KEY_BYTES,
  MasterKey,
  MasterKeyError,
  masterKeyLayer,
  type KeyStore,
  type MasterKeyBackend,
  type SecurityRunner,
} from "./masterKey";
