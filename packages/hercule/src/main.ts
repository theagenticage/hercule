#!/usr/bin/env bun
// `hercule github-token` runs on every `gh` call, so it must start fast. The
// build splits the bundle into chunks, and a chunk is loaded only when it is
// imported. This verb is chosen here, before `./index` is imported, so it loads
// only the client's small chunk and never the dispatcher's.
if (process.argv[2] === "github-token") {
  const { runGithubToken } = await import("@hercule/runner/github-token");
  await runGithubToken();
} else if (process.argv[2] === "measure-disk-usage") {
  // The runner starts this verb in a child process to walk a folder. It reads
  // no Home, so it is chosen here, before the dispatcher is imported.
  const { runMeasureDiskUsage } = await import("@hercule/runner/measure-disk-usage");
  runMeasureDiskUsage(process.argv.slice(3));
} else {
  const { dispatch } = await import("./index");
  await dispatch(process.argv.slice(2));
}
