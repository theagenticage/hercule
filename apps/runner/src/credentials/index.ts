/**
 * Git credentials on this machine (spec 13 section 9):
 *
 * - the Unix socket that git's credential helper connects to;
 * - the helper itself;
 * - the relay that forwards a request to the controller;
 * - the environment that tells git to use the helper.
 */
export { buildGitCredentialEnv, buildSocketPath } from "./env";
export { answerCredentialQuestion, RUNNER_WORKSPACE_VARIABLE, runCredentialAction } from "./helper";
export { makeCredentialRelay, type CredentialRelay } from "./relay";
export { serveCredentialSocket, type CredentialAsk } from "./socket";
