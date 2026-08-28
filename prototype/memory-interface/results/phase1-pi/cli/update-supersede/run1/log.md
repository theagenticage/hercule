# pi/cli/update-supersede/run1

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** bash({"command":"hydra memory read hydra-project"})
bash({"command":"ls -la; ls docs/adr 2>/dev/null || echo \"no docs/adr here\""})
bash({"command":"hydra memory write hydra-project <<'EOF'\n# hydra-project\n> Hydra architecture decisions, repo facts, open )

**assistant:** Noted the GitLab move in memory (GitHub now marked read-only mirror).

Merged ADRs: 0001, 0002, 0003, 0004, 0014.

## s1 flush
**tools:** (none)

**assistant:** DONE
Nothing new to record: the GitLab move was already written to `hydra-project` earlier this turn-set, and the ADR list was already current.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url removed"}
