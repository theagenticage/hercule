# files/update-supersede/run1

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** Bash({"command":"ls docs/adr/ 2>/dev/null | sort","description":"List ADR files"})
Read({"file_path":"/private/tmp/claude-501/-Users-rogier-Dev-agentick-agentick-next/839a9e95-785c-4927-a4ab-7bacbf8fbd71/scra)
Bash({"command":"find . -iname \"*adr*\" -not -path \"*/node_modules/*\" 2>/dev/null | head -50","description":"Find ADR-rela)
Bash({"command":"pwd && ls -la && echo \"---log---\" && git log --oneline -30","description":"Check working directory content)
Bash({"command":"git show --stat HEAD~1 2>/dev/null | head -20; echo \"---\"; git log --all --diff-filter=A --name-only --for)
Bash({"command":"git log --all --name-only --format=\"COMMIT:%H %s\" | grep -B5 -i \"adr\" | head -100","description":"Search)
Bash({"command":"for c in 2fb5429 6b3977a 9d656bf d176f4a; do echo \"=== $c ===\"; git show --stat --format=\"%s\" $c | grep )
Read({"file_path":"/private/tmp/claude-501/-Users-rogier-Dev-agentick-agentick-next/839a9e95-785c-4927-a4ab-7bacbf8fbd71/scra)
Edit({"replace_all":false,"file_path":"/private/tmp/claude-501/-Users-rogier-Dev-agentick-agentick-next/839a9e95-785c-4927-a4)

**assistant:** No new ADR files in those four — they only touched CONTEXT.md, design docs, and the experiment harness. So the full merged set is ADR 0001–0019 (all merged, one commit per number, no gaps or reverts).

Now let me update memory: the repo move to GitLab, and refresh the stale ADR list.Repo moved: **gitlab.com/rogier/hydra** now noted (GitHub is a read-only mirror) — updated memory.

Merged ADRs so far, 0001 through 0019, all merged with no gaps (0020+ tickets like monitoring/Intake/design-language haven't produced new ADR files yet — those commits only touched CONTEXT.md and prototype docs).

## s1 flush
**tools:** (none)

**assistant:** Already recorded both items (repo move to GitLab and full ADR 0001–0019 list) into memory/topics/hydra-project.md during this conversation. Nothing further to add.

DONE — no new writes; repo move to gitlab.com/rogier/hydra and full merged ADR list (0001-0019) were already saved to hydra-project.md earlier this session.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url removed"}
