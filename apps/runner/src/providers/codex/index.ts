/**
 * The Codex adapter, as the rest of the runner sees it: the adapter itself, the
 * id it is registered under, and the child shape the process seam spawns for it.
 * Nothing else in this folder is anyone else's business.
 */
export { CODEX, codex } from "./adapter";
export type { AppServerChild, AppServerSpawn } from "./rpc";
