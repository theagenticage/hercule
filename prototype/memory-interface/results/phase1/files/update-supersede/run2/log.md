# files/update-supersede/run2

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** Bash({"command":"find . -path ./memory -prune -o -iname \"*adr*\" -print 2>/dev/null | grep -v '/\\.git/'","description":"Fin)
Read({"file_path":"/private/tmp/claude-501/-Users-rogier-Dev-agentick-agentick-next/839a9e95-785c-4927-a4ab-7bacbf8fbd71/scra)
Bash({"command":"git log --oneline -30 2>&1; echo \"---\"; git log --all --diff-filter=A --name-only 2>&1 | grep -i adr | sor)
Bash({"command":"ls docs/adr/ | sort","description":"List current ADR files"})
Bash({"command":"ls docs/ 2>&1; echo \"---branch---\"; git branch --show-current; echo \"---status---\"; git status; echo \"-)
Bash({"command":"git show HEAD --stat | head -20; echo \"---ls tree---\"; git ls-tree -r HEAD --name-only | grep -i adr | sor)
Edit({"replace_all":false,"file_path":"/private/tmp/claude-501/-Users-rogier-Dev-agentick-agentick-next/839a9e95-785c-4927-a4)

**assistant:** Updated memory: Hydra's canonical repo is now `gitlab.com/rogier/hydra`, with GitHub kept as a read-only mirror.

Merged ADRs so far (per memory): **0001, 0002, 0003, 0004, 0014**.

## s1 flush
**tools:** (none)

**assistant:** Already recorded during the conversation — the repo move to GitLab was written into `memory/topics/hydra-project.md`. Nothing else durable to add.

DONE — recorded repo move (gitlab.com/rogier/hydra, GitHub now read-only mirror) in hydra-project topic.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url removed"}
