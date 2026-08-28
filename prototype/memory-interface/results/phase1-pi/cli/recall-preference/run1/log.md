# pi/cli/recall-preference/run1

## s1 t1
**user:** Two things. First, from now on call me Ro - I don't like my full name in chats. Second, what's a sensible cadence for rotating Discord bot tokens? Two lines max.

**tools:** bash({"command":"hydra memory read core"})
bash({"command":"hydra memory write core --content '# core\n> Who Ro is, how he likes to work, what is live right now\n\n## R)

**assistant:** Noted, Ro - memory updated.

Discord tokens don't expire, so there's no forced cadence: rotate every 6-12 months for hygiene and immediately on any suspicion of a leak (token shows in logs, repo, etc.). Rotation is just a reset in the dev portal plus an env var update, so cheap to do.

## s1 flush
**tools:** (none)

**assistant:** DONE
Recorded the "call me Ro, not my full name" preference in core (updated this session; nothing else durable came up).

## s2 t1
**user:** Unrelated: give me three ideas for a weekly review ritual, one line each.

**tools:** (none)

**assistant:** 1. Friday 30-min "open loops" scan: walk every project topic in memory, close or archive what's stale.
2. Monday-morning "one thing" note: pick the single change that would make next week easier, write it down.
3. Sunday journal: reread the week's session recollections, distill three lessons into a memory topic.

## s2 flush
**tools:** (none)

**assistant:** DONE — nothing durable to record; the weekly-review ideas were one-off brainstorming with no decision made.

## s3 t1
**user:** Quick check: what do you call me, and where does that come from? One line.

**tools:** (none)

**assistant:** I call you Ro — that comes from my core memory note to address you as "Ro, not your full name."

## s3 flush
**tools:** (none)

**assistant:** DONE — nothing durable to record; the only fact in this session (calling you Ro) was already in core memory.

## verdict
{"pass":true,"notes":"recorded at s1t1 in core"}
