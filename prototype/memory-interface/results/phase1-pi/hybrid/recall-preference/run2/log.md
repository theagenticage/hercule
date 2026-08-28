# pi/hybrid/recall-preference/run2

## s1 t1
**user:** Two things. First, from now on call me Ro - I don't like my full name in chats. Second, what's a sensible cadence for rotating Discord bot tokens? Two lines max.

**tools:** read({"path":"memory/core.md"})
bash({"command":"hydra memory write core --content '# core\n> Who Rogier is, how he likes to work, what is live right now\n\n)

**assistant:** Got it, Ro - noted.

Token rotation: there's no forced expiry on Discord bot tokens, so rotate on events rather than a calendar: leak suspicion, staff/laptop changes, or repo housecleaning. If you want a hygiene rhythm anyway, once a year is plenty; the bigger win is keeping tokens out of logs and config files in the first place.

## s1 flush
**tools:** (none)

**assistant:** DONE - nothing new to record; the "call me Ro" preference was already saved to core earlier in this session, and the token rotation advice was transient.

## s2 t1
**user:** Unrelated: give me three ideas for a weekly review ritual, one line each.

**tools:** (none)

**assistant:** 1. Friday 16:00, 20 minutes: scan the week's commits, PRs, and closed issues, then write three bullet points (win, miss, next week's one priority) into a WEEKLOG.md.
2. Monday coffee walk with a voice memo: talk through what shipped, what stalled, and why, then transcribe one action item into the tracker.
3. Sunday evening inbox-zero-style sweep: zero out every project's "loose ends" list (drafts, parked branches, unanswered threads) before the week starts.

## s2 flush
**tools:** (none)

**assistant:** DONE — nothing durable to record; the ritual ideas were one-off brainstorming, not decisions or preferences.

## s3 t1
**user:** Quick check: what do you call me, and where does that come from? One line.

**tools:** (none)

**assistant:** I call you Ro — a standing preference from my core memory (you dislike your full name in chats).

## s3 flush
**tools:** (none)

**assistant:** DONE — nothing durable to record; the only exchange was a recall check on your name, which is already in core memory.

## verdict
{"pass":true,"notes":"recorded at s1t1 in core"}
