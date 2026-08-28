# hybrid/update-supersede/run2

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** Bash({"command":"find /private/tmp/claude-501/-Users-rogier-Dev-agentick-agentick-next/839a9e95-785c-4927-a4ab-7bacbf8fbd71/s)
Read({"file_path":"/private/tmp/claude-501/-Users-rogier-Dev-agentick-agentick-next/839a9e95-785c-4927-a4ab-7bacbf8fbd71/scra)
Bash({"command":"find /private/tmp/claude-501/-Users-rogier-Dev-agentick-agentick-next/839a9e95-785c-4927-a4ab-7bacbf8fbd71 -)
Bash({"command":"find / -maxdepth 6 -iname \"memory\" -type d 2>/dev/null | grep -v node_modules","description":"Search files)
Bash({"command":"which hydra; hydra memory --help 2>&1 | head -50","description":"Check hydra CLI availability and memory com)
Bash({"command":"hydra memory read hydra-project","description":"Read hydra-project memory topic"})
Bash({"command":"cat <<'EOF' | hydra memory write hydra-project\n# hydra-project\n> Hydra architecture decisions, repo facts,)

**assistant:** There's a `hydra memory read` command. Let me use it directly.Noted the repo move — I've updated memory: hydra now lives at gitlab.com/rogier/hydra, GitHub is a read-only mirror.

Merged ADRs so far: **0001–0019**.

## s1 flush
**tools:** (none)

**assistant:** Already recorded the repo move and ADR note in the hydra-project topic during this conversation. Nothing else durable to add.

DONE — no new writes; repo move (GitHub→GitLab) and ADR 0001-0019 note were already saved to hydra-project topic.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url removed"}
