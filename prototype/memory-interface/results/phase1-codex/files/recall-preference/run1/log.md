# codex/files/recall-preference/run1

## s1 t1
**user:** Two things. First, from now on call me Ro - I don't like my full name in chats. Second, what's a sensible cadence for rotating Discord bot tokens? Two lines max.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,120p' memory/core.md\"")
FileChange(update memory/core.md)

**assistant:** I’ll update your assistant memory with the preferred name, then answer briefly.
A sensible default is every 90 days, plus immediately after suspected exposure or access changes.  
Store tokens in a secret manager and automate rotation where possible.

## s1 flush
**tools:** (none)

**assistant:** DONE  
Recorded that Rogier prefers to be called Ro.

## s2 t1
**user:** Unrelated: give me three ideas for a weekly review ritual, one line each.

**tools:** (none)

**assistant:** - Friday shutdown: review wins, open loops, and pick the three priorities for next week.
- Sunday reset: scan your calendar, clear commitments, and block focused work before the week starts.
- Wednesday midpoint: check what drifted, drop one low-value task, and recommit to the week’s main outcome.

## s2 flush
**tools:** (none)

**assistant:** DONE  
Nothing durable to record.

## s3 t1
**user:** Quick check: what do you call me, and where does that come from? One line.

**tools:** (none)

**assistant:** I call you Ro, from `memory/core.md`.

## s3 flush
**tools:** (none)

**assistant:** DONE — Nothing new to record.

## verdict
{"pass":true,"notes":"recorded at s1t1 in core"}
