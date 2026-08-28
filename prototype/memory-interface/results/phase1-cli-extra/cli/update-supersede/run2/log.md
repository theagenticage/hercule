# claude/cli/update-supersede/run2

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** Bash({"command":"find /private/tmp/claude-501/-Users-rogier-Dev-agentick-agentick-next/839a9e95-785c-4927-a4ab-7bacbf8fbd71/s)
Bash({"command":"hydra memory read hydra-project","description":"Read hydra-project memory topic"})
Bash({"command":"cd /private/tmp/claude-501/-Users-rogier-Dev-agentick-agentick-next/839a9e95-785c-4927-a4ab-7bacbf8fbd71/scr)
Bash({"command":"cd /private/tmp/claude-501/-Users-rogier-Dev-agentick-agentick-next/839a9e95-785c-4927-a4ab-7bacbf8fbd71/scr)
Edit({"replace_all":false,"file_path":"/dev/stdin","old_string":"placeholder","new_string":"placeholder"})
Bash({"command":"cd /private/tmp/claude-501/-Users-rogier-Dev-agentick-agentick-next/839a9e95-785c-4927-a4ab-7bacbf8fbd71/scr)

**assistant:** Noted the GitLab move — but heads up: this worktree's `origin` remote still points to `github.com/rogierpennink/hydra.git`, not GitLab. Want me to update it, or is that intentional for now (e.g. mirror not yet flipped everywhere)?

All 19 ADRs are merged to main: **0001–0019**.

## s1 flush
**tools:** (none)

**assistant:** Already recorded in the same turn it happened — hydra-project topic now has the GitLab move (with the unresolved GitHub-remote discrepancy) and the full merged ADR list 0001–0019.

DONE — nothing new to record; both facts were written to the `hydra-project` topic during this conversation.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url kept, qualified as mirror"}
