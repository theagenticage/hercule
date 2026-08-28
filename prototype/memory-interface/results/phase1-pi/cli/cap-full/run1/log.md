# pi/cli/cap-full/run1

## s1 t1
**user:** Three updates on Hydra, please make sure they stick: (1) we are going with Bun to compile the single binary, (2) ADR 0018 on packaging is merged, (3) runner join tokens are single-use, that is now final. Then tell me how many ADRs you know about, number only.

**tools:** bash({"command":"hydra memory read hydra-project"})
bash({"command":"date +%Y-%m-%d"})
bash({"command":"hydra memory write hydra-project << 'EOF'\n# hydra-project\n> Hydra architecture decisions, repo facts, open)

**assistant:** Three of those touch `hydra-project`, which is already at its 12k cap (the decision log is full of duplicate entries). I'll consolidate while recording the updates.All three stuck in `hydra-project` (consolidated the duplicate decision-log entries while I was in there, 11.8k → 2.8k chars):

1. Bun compiles the single binary
2. ADR 0018 (packaging) added to merged ADRs
3. Runner join tokens single-use, marked FINAL, open thread closed

6 (0001, 0002, 0003, 0004, 0014, 0018)

## s1 flush
**tools:** (none)

**assistant:** DONE — nothing new to record; all three updates (Bun binary, ADR 0018 merged, single-use join tokens final) were already written to `hydra-project` this session.

## verdict
{"pass":true,"notes":"facts 3/3; hydra-project 2834 chars (was 11824); stub rejects 0; new topics none"}
