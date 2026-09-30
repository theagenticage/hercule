/**
 * Git credentials on this machine:
 *
 * - the Unix socket that git's credential helper connects to;
 * - the helper itself;
 * - the relay that forwards a request to the controller;
 * - the environment that tells git to use the helper.
 *
 * Spec 13 section 9 owns the rules.
 */
export { buildGitCredentialEnv, buildSocketPath } from "./env";
export { answerCredentialQuestion, RUNNER_WORKSPACE_VARIABLE, runCredentialAction } from "./helper";
export { makeCredentialRelay, type CredentialRelay } from "./relay";
export { serveCredentialSocket, type CredentialAsk } from "./socket";
