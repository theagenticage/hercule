# pi/files/recall-preference/run1

## s1 t1
**user:** Two things. First, from now on call me Ro - I don't like my full name in chats. Second, what's a sensible cadence for rotating Discord bot tokens? Two lines max.

**tools:** edit({"edits":[{"newText":"- Address him as Ro; he dislikes his full name in chats. Dutch native, prefers English for work ch)

**assistant:** Noted, Ro.

Discord bot tokens don't expire, so no fixed cadence is needed: rotate on suspicion of a leak (token in logs, repo, screenshot) or when anyone who had access leaves. If you want a policy baseline anyway, 90 days is the usual number, but for a solo-run bot that's mostly ritual.

## s1 flush
**tools:** (none)

**assistant:** DONE - already recorded during the session: your preference to be addressed as Ro (updated in core.md).

## s2 t1
**user:** Unrelated: give me three ideas for a weekly review ritual, one line each.

**tools:** (none)

**assistant:** 1. Friday 16:00, 20 minutes: skim the week's commits and issues closed, write three lines (what shipped, what stalled, what to kill).
2. Monday 08:30, read-only start: open the hydra project board and pick one open thread to either advance or explicitly drop.
3. Sunday evening, 10 minutes off-screen: dictate a voice memo of what's on your mind, have it transcribed into a single "brain dump" note you review Monday.

## s2 flush
**tools:** (none)

**assistant:** DONE — nothing durable in this conversation (a one-off brainstorm of weekly review ideas, no decisions or preferences stated), so I recorded nothing.

## s3 t1
**user:** Quick check: what do you call me, and where does that come from? One line.

**tools:** (none)

**assistant:** I call you Ro — that's noted in my core memory as your preferred name (you dislike your full name in chats).

## s3 flush
**tools:** (none)

**assistant:** DONE — nothing durable to record; the only fact in this conversation (calling you Ro) is already in core memory.

## verdict
{"pass":true,"notes":"recorded at s1t1 in core"}
