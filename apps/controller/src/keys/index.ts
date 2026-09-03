/** The Master Key: created at first run, never leaves its machine (spec 13 section 2.2). */
export {
  defaultBackend,
  KEYCHAIN_SERVICE,
  keychainReadCommand,
  keychainWriteCommand,
  MASTER_KEY_BYTES,
  MasterKey,
  MasterKeyError,
  masterKeyLayer,
  type MasterKeyBackend,
} from "./masterKey";
