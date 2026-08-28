# pi/hybrid/cap-full/run2

## s1 t1
**user:** Three updates on Hydra, please make sure they stick: (1) we are going with Bun to compile the single binary, (2) ADR 0018 on packaging is merged, (3) runner join tokens are single-use, that is now final. Then tell me how many ADRs you know about, number only.

**tools:** read({"path":"memory/topics/hydra-project.md"})
bash({"command":"date +%Y-%m-%d"})
bash({"command":"hydra memory write hydra-project --content '# hydra-project\n> Hydra architecture decisions, repo facts, ope)
bash({"command":"grep -E \"Bun|0018|single-use\" memory/topics/hydra-project.md"})

**assistant:** Three of those touch the full `hydra-project` topic, so I'll consolidate it while writing (the decision log is heavily duplicated). First, today's date for the log:All three are recorded in `hydra-project` (the topic was at its cap, so I also deduplicated the decision log, which was full of repeated entries):

1. Bun compiles the single binary; npm install rejected.
2. ADR 0018 (packaging) added to the merged list.
3. Runner join tokens single-use, marked final; both open threads closed.

6

## s1 flush
**tools:** (none)

**assistant:** DONE — nothing new to record; the three updates (Bun binary, ADR 0018 merged, single-use join tokens final) were already written to `hydra-project` this session, including the decision-log consolidation.

## verdict
{"pass":true,"notes":"facts 3/3; hydra-project 2915 chars (was 11824); stub rejects 0; new topics none"}
