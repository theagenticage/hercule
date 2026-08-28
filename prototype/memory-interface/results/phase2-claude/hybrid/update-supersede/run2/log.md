# claude/hybrid+journal/update-supersede/run2

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** Bash({"command":"cat memory/topics/hydra-project.md 2>/dev/null; echo \"---\"; find . -path ./node_modules -prune -o -name \")
Bash({"command":"hydra memory write hydra-project --content \"$(cat <<'EOF'\n# hydra-project\n> Hydra architecture decisions,)

**assistant:** Noted the repo move — updated to `gitlab.com/rogier/hydra`, GitHub now read-only mirror.

Merged ADRs so far: **0001, 0002, 0003, 0004, 0014**.

## s1 flush
**tools:** Bash({"command":"hydra memory --help 2>&1 | head -20"})

**assistant:** DONE — nothing to journal, the repo-move fact was already written directly to the `hydra-project` topic and the ADR list was unchanged.

## s1 dream
**tools:** Bash({"command":"hydra memory journal-unread"})

**assistant:** DONE
No unread journal entries — nothing to fold in.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url removed"}
