# hybrid/update-supersede/run1

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** Bash({"command":"find / -maxdepth 6 -iname \"AGENTS.md\" 2>/dev/null; echo \"---\"; find / -type d -iname \"adr\" 2>/dev/null)
Read({"file_path":"/private/tmp/claude-501/-Users-rogier-Dev-agentick-agentick-next/839a9e95-785c-4927-a4ab-7bacbf8fbd71/scra)
Bash({"command":"ls memory/ 2>/dev/null; echo \"---topics---\"; ls memory/topics/ 2>/dev/null; echo \"---adr search in cwd tr)
Read({"file_path":"memory/topics/hydra-project.md"})
Bash({"command":"hydra memory write hydra-project --content \"$(cat <<'EOF'\n# hydra-project\n> Hydra architecture decisions,)

**assistant:** Noted — repo moved to gitlab.com/rogier/hydra, GitHub is now read-only mirror. Updated memory.

Merged ADRs so far: **0001, 0002, 0003, 0004, 0014**.

## s1 flush
**tools:** (none)

**assistant:** Already recorded during the conversation — the GitLab repo move (gitlab.com/rogier/hydra, GitHub now read-only mirror) is saved in the hydra-project topic. Nothing else durable to add.

DONE — no new writes; repo move to gitlab.com/rogier/hydra was already recorded in hydra-project topic.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url removed"}
