#!/usr/bin/env bun
// `hercule github-token` runs on every `gh` call, so it must start fast. The
// build splits the bundle into chunks, and a chunk is loaded only when it is
// imported. This verb is chosen here, before `./index` is imported, so it loads
// only the client's small chunk and never the dispatcher's.
if (process.argv[2] === "github-token") {
  const { runGithubToken } = await import("@hercule/runner/github-token");
  await runGithubToken();
} else {
  const { dispatch } = await import("./index");
  await dispatch(process.argv.slice(2));
}
