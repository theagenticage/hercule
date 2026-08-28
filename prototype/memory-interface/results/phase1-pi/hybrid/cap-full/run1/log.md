# pi/hybrid/cap-full/run1

## s1 t1
**user:** Three updates on Hydra, please make sure they stick: (1) we are going with Bun to compile the single binary, (2) ADR 0018 on packaging is merged, (3) runner join tokens are single-use, that is now final. Then tell me how many ADRs you know about, number only.

**tools:** read({"path":"memory/topics/hydra-project.md"})
bash({"command":"date +%F"})
bash({"command":"hydra memory --help 2>&1 | head -40"})
bash({"command":"hydra memory write hydra-project <<'EOF'\n# hydra-project\n> Hydra architecture decisions, repo facts, open )
bash({"command":"hydra memory read hydra-project | sed -n '/## Decisions/,/## Open/p'"})

**assistant:** The hydra-project topic is at 11.8k of its 12k cap, and its decision log is full of repeated entries. I'll consolidate while applying your three updates. First, let me check the CLI and today's date:Writing the consolidated document with all three updates applied:All three updates are recorded and verified:

1. **Bun for the single binary** - added to the decision log; the "single binary vs npm install" open thread is closed.
2. **ADR 0018 merged** - listed under merged ADRs.
3. **Runner join tokens single-use, final** - open thread and log updated to say final.

One note: the topic was at 11.8k/12k chars because the decision log had accumulated dozens of duplicate entries. I deduplicated it to one line per decision, so the document is now 2962/12000 chars with nothing substantive lost.

ADRs known: **6** (0001, 0002, 0003, 0004, 0014, 0018)

## s1 flush
**tools:** (none)

**assistant:** DONE - nothing new to record; the three updates from this session (Bun single binary, ADR 0018 merged, single-use join tokens final) were already written to `hydra-project` and verified.

## verdict
{"pass":true,"notes":"facts 3/3; hydra-project 2962 chars (was 11824); stub rejects 0; new topics none"}
