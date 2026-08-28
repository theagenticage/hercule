# cli/update-supersede/run1

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** Bash({"command":"hydra memory read hydra-project"})
Bash({"command":"find / -maxdepth 2 -iname \"*hydra*\" 2>/dev/null; echo \"---\"; find / -type d -iname \"adr\" 2>/dev/null |)
Bash({"command":"hydra memory write hydra-project --content \"$(cat <<'EOF'\n# hydra-project\n> Hydra architecture decisions,)

**assistant:** Noted the move — repo is now at gitlab.com/rogier/hydra, GitHub is a read-only mirror. Updated it in memory.

ADRs merged so far: **0001, 0002, 0003, 0004, 0014**.

## s1 flush
**tools:** (none)

**assistant:** Already recorded (repo move to GitLab + read-only GitHub mirror) in the hydra-project topic during this session. Nothing else durable to add.

DONE — nothing further recorded this turn; hydra-project topic already updated with the GitLab move.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url removed"}
