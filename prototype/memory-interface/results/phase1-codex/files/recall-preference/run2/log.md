# codex/files/recall-preference/run2

## s1 t1
**user:** Two things. First, from now on call me Ro - I don't like my full name in chats. Second, what's a sensible cadence for rotating Discord bot tokens? Two lines max.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,80p' memory/core.md\"")
FileChange(update memory/core.md)

**assistant:** I’ll update your durable name preference, then answer the token-rotation question briefly.
Got it, Ro.  
Rotate Discord bot tokens every 3–6 months, and immediately after any suspected exposure or personnel/access change.

## s1 flush
**tools:** (none)

**assistant:** DONE — recorded that you prefer to be called Ro.

## s2 t1
**user:** Unrelated: give me three ideas for a weekly review ritual, one line each.

**tools:** (none)

**assistant:** - Review wins, misses, and lessons from the week, then choose one improvement for next week.
- Clear your inbox and task list, identify the three most important priorities, and schedule them.
- Take a quiet walk and reflect on energy, relationships, and progress, then write down one adjustment per area.

## s2 flush
**tools:** (none)

**assistant:** DONE — Nothing durable to record.

## s3 t1
**user:** Quick check: what do you call me, and where does that come from? One line.

**tools:** (none)

**assistant:** I call you Ro, from your memory profile in `memory/core.md`.

## s3 flush
**tools:** (none)

**assistant:** DONE — Nothing new to record.

## verdict
{"pass":true,"notes":"recorded at s1t1 in core"}
