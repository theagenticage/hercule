# Plugins

One workspace package per plugin, at `plugins/<id>`, named `@hercule/plugin-<id>`
(see [`docs/spec/05-plugins.md`](../docs/spec/05-plugins.md)).

A plugin package depends on `@hercule/plugin-host` and `effect`, and on nothing else in
this repository: a plugin reaches no controller internal, and everything it needs is
handed to it through the host. It exports a `Plugin` - a manifest, a `register` that
declares contributions, and an `activate` that starts machinery and hands back its own
teardown.

Every plugin runs in-process on the controller, and installed means compiled in. A
plugin is loaded only once it is listed in
`apps/controller/src/plugins/registry.ts`, which is the whole inventory: there is no
discovery, no dynamic loading and no install step. The plugins shipped so far:

| Package | Contributes |
| --- | --- |
| `@hercule/plugin-claude-code` | the `claude-code` provider |
| `@hercule/plugin-codex` | the `codex` provider |
| `@hercule/plugin-pi` | the `pi` provider |
| `@hercule/plugin-github` | the `github` connection type, the event source that polls GitHub, and the workflow actions on issues and pull requests |

The runner entrypoint imports no plugin host and no plugin package.
