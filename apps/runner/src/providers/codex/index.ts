/**
 * The public face of the Codex adapter: the adapter itself, the provider id it
 * is registered under, and the types of the child process the process seam
 * spawns for it. Everything else in this folder is internal.
 */
export { CODEX, codex } from "./adapter";
export type { AppServerChild, AppServerSpawn } from "./rpc";
