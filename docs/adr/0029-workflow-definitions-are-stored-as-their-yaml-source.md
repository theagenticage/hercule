# 29. Workflow definitions are stored as their YAML source

Date: 2026-09-01

## Status

Accepted. Decided by [Web app details (#45)](https://github.com/rogierpennink/hydra/issues/45). Refines [ADR 0001](./0001-runs-freeze-an-execution-plan.md) (a run still freezes the parsed plan) and [ADR 0008](./0008-workflow-graphs-route-on-declared-outputs.md) (the definition stays declarative).

## Context

Spec 07 defines the workflow as a declarative `Workflow` object and spec 14 gives it a text editor, but no ticket had said what text the editor edits or what the controller stores. Three writers exist: the user in the web editor (hand-written, comments expected), agents through `workflow.create` / `workflow.submit` (JSON objects, never read back as text), and a possible future where workflow definitions are git-versioned artifacts the way GitHub Actions files are. The user named that future as the reason to weigh this carefully: a definition should stay exactly as written.

Prior art splits on which side holds the truth. Git-native CI (GitHub Actions, GitLab CI) stores only text and parses per run. Kubernetes stores the structured object and loses comments on `kubectl edit`; it works because GitOps keeps the YAML in git as the real truth. Home Assistant's UI editor regenerates `automations.yaml` and destroys users' comments and ordering - the cautionary tale for a lossy projection. Kestra stores the YAML source string beside the parsed form so its editor and git sync round-trip byte-exactly. UI-first tools (n8n, Grafana, Windmill) store JSON that nobody hand-writes.

Hercule's standing decision is that controller state is the truth and there is no repo-local config. A git story is compatible with that as export/import or a sync *to* a repo, and it needs byte-exact round-trip or every diff is noise. The agent step `prompt` is multi-line and full of quotes and `{{ }}` templates, so JSON's escaped single-line strings are unreadable and un-diffable; JSON5/JSONC share that flaw, TOML turns a graph of steps and edges into array-of-tables soup, HCL and the newer configuration languages lack the familiarity every CI user and every model already has with YAML.

## Decision

The stored form of a workflow is the **YAML 1.2 source text**, kept byte for byte. The controller parses it into the `Workflow` shape on every write - a derived column, never written on its own - for validation, the editor's DAG preview and stamping; a run's frozen plan holds the parsed form only.

- `workflow.create` / `update` / `submit` accept `{ source }` or `{ definition }`; an object is rendered to canonical YAML by one deterministic rule (contract key order, block scalars for strings containing a newline, double quotes elsewhere when quoting is needed, two-space indent) and the rendered text is what gets stored.
- `workflow.read` returns the source and never a parsed object; clients parse it with the shared contract schema.
- `id`, `enabled`, the timestamps and each start trigger's `status` are row state outside the text, so an enable toggle or a breaker trip never rewrites the user's file.

## Consequences

- Comments, key order and formatting survive every save; a later git sync is byte-exact; agents lose nothing because they keep sending objects.
- One extra column and one render path (object to canonical YAML). The parsed column is a cache with the same relationship to the text as an FTS index; there is no second truth.
- YAML's two traps travel with it: `{{` opening a flow mapping in a plain scalar and CEL's `? :` / `: ` needing quotes. The editor's autocomplete inserts block scalars for prompts and quotes for conditions, and validation names the offending line; GitHub Actions users already carry the same habits.
- The parser is `eemeli/yaml` (YAML 1.2, so `on: yes` is a string); the same package parses in the browser for the preview.
