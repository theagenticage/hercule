# Skill frontmatter vs approvals (agy)

Setup: fresh git repo under /var/tmp/hercule-1282-work/skillfm-<name>, `.agents/skills/marker-skill/SKILL.md`, default mode, prompt "Use the marker-skill skill.", permission requests answered allow_once. Script: /tmp/hercule-1282/recorder/scenarios/skill-fm.ts

| Run | frontmatter extra | recording | result |
|---|---|---|---|
| control | none | rec9/skill-control.jsonl | skill read, `echo MARKER1293` asked (1 request_permission) |
| string | `allowed-tools: run_command` | rec9/skill-string.jsonl | same: asked |
| list | `allowed-tools: ["run_command"]` | rec9/skill-list.jsonl | same: asked |
| underscore | `allowed_tools: run_command` | rec9/skill-underscore.jsonl | same: asked |

Conclusion: no allowed-tools variant changes approvals. Skill is loaded (File .agents/skills/marker-skill/SKILL.md tool call), the key is ignored.

Binary (LC_ALL=C grep -a): yaml struct tags for frontmatter-like keys: name, description, disable-model-invocation, disable-slash-command, metadata, trigger, glob(s), enabled, version, publisher. None is about tools or permissions. `allowed_tools` hits are protobuf (genai/vertex) and built-in agent tool lists, not skill frontmatter.

Docs https://antigravity.google/docs/skills: keys are `name` (optional) and `description` (required) only; nothing on tools or permissions.
