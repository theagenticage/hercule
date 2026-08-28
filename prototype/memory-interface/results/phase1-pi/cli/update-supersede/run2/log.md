# pi/cli/update-supersede/run2

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** bash({"command":"hydra memory read hydra-project"})
bash({"command":"hydra memory write hydra-project <<'EOF'\n# hydra-project\n> Hydra architecture decisions, repo facts, open )

**assistant:** Noted the GitLab move in memory: repo is now gitlab.com/rogier/hydra, GitHub a read-only mirror.

Merged ADRs: 0001, 0002, 0003, 0004, 0014.

## s1 flush
**tools:** (none)

**assistant:** DONE - nothing new to record; the only durable fact this session (repo moved to gitlab.com/rogier/hydra, GitHub now a read-only mirror) was already written to the hydra-project topic earlier.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url removed"}
