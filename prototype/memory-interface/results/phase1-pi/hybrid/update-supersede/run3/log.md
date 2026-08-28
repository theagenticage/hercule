# pi/hybrid/update-supersede/run3

## s1 t1
**user:** Heads up: we moved the hydra repo to gitlab.com/rogier/hydra last night; GitHub is now just a read-only mirror. Also, remind me which ADRs are merged so far, numbers only.

**tools:** read({"path":"memory/topics/hydra-project.md"})
bash({"command":"ls docs/adr/ 2>/dev/null || find . -maxdepth 3 -name 'adr' -type d 2>/dev/null"})
bash({"command":"ls ~/Dev/agentick/agentick-next/docs/adr/ 2>/dev/null && head -6 ~/Dev/agentick/agentick-next/docs/adr/*.md )
bash({"command":"ls ~/Dev/agentick/agentick-next/docs/adr/ 2>/dev/null; grep -i '^## *status\\|^status' ~/Dev/agentick/agenti)
bash({"command":"cd ~/Dev/agentick/agentick-next/docs/adr && grep -ril 'status' . | head; echo ---; head -8 0001-*.md; echo -)
bash({"command":"cd ~/Dev/agentick/agentick-next && git status --short docs/adr/ && git log --oneline -1 -- docs/adr/"})
bash({"command":"hydra memory write hydra-project <<EOF\n# hydra-project\n> Hydra architecture decisions, repo facts, open th)

**assistant:** All 19 ADR files (0001-0019) are committed in `docs/adr/` with no gaps, and my memory's list was stale. Updating the topic with the repo move and the corrected ADR state:Noted the GitLab move in memory (GitHub noted as read-only mirror).

ADRs merged: **0001 through 0019**, all of them, no gaps.

One side effect: ADR 0018 (single self-contained binary) had already settled the packaging question, so I dropped that stale open thread from memory too.

## s1 flush
**tools:** (none)

**assistant:** DONE — nothing new to record; the GitLab repo move, the full ADR 0001-0019 list, and the cleared packaging thread were all written to `hydra-project` during the conversation.

## verdict
{"pass":true,"notes":"recorded at s1t1 in topics/hydra-project; old url kept, qualified as mirror"}
