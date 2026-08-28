# codex/hybrid/recall-preference/run1

## s1 t1
**user:** Two things. First, from now on call me Ro - I don't like my full name in chats. Second, what's a sensible cadence for rotating Discord bot tokens? Two lines max.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,80p' memory/core.md && hydra memory --help\"")
Bash("/bin/zsh -lc 'hydra memory write core --content $'\"'# core\\\\n> Who Ro is, how he likes to work, what is live right n)

**assistant:** Got it, Ro.  
Rotate Discord bot tokens quarterly, and immediately after suspected exposure, staff turnover, or security changes.

## s1 flush
**tools:** (none)

**assistant:** DONE  
No new durable information; Ro preference was already recorded.

## s2 t1
**user:** Unrelated: give me three ideas for a weekly review ritual, one line each.

**tools:** (none)

**assistant:** - Sunday reset: review wins, unfinished tasks, and choose three priorities for the coming week.
- Friday debrief: note what worked, what drained you, and one experiment to try next week.
- Monday compass: check goals, calendar, and commitments, then write a short “focus / avoid / protect” list.

## s2 flush
**tools:** (none)

**assistant:** DONE — Nothing durable to record.

## s3 t1
**user:** Quick check: what do you call me, and where does that come from? One line.

**tools:** (none)

**assistant:** I call you Ro, from the `memory/core.md` assistant-memory file.

## s3 flush
**tools:** (none)

**assistant:** DONE — Nothing recorded; “Ro” was already in memory.

## verdict
{"pass":true,"notes":"recorded at s1t1 in core"}
