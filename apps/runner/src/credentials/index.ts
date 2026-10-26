/**
 * Git credentials on this machine:
 *
 * - the Unix socket that git's credential helper connects to;
 * - the helper itself;
 * - the relay that forwards a request to the controller;
 * - the runner's in-memory copy of each GitHub Connection's token;
 * - the environment that tells git to use the helper.
 *
 * Spec 13 section 9 owns the rules.
 */
export { buildGitCredentialEnv, buildSocketPath, quoteShellWord } from "./env";
export {
  answerCredentialQuestion,
  RUNNER_SOCKET_VARIABLE,
  RUNNER_WORKSPACE_VARIABLE,
  runCredentialAction,
} from "./helper";
export { makeGithubTokenCopies, type GithubTokenCopies } from "./github-tokens";
export { makeCredentialRelay, type CredentialRelay } from "./relay";
export { serveCredentialSocket, type CredentialAsk } from "./socket";
