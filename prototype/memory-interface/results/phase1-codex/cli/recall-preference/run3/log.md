# codex/cli/recall-preference/run3

## s1 t1
**user:** Two things. First, from now on call me Ro - I don't like my full name in chats. Second, what's a sensible cadence for rotating Discord bot tokens? Two lines max.

**tools:** Bash("/bin/zsh -lc 'hydra memory read core'")
Bash("/bin/zsh -lc \"hydra memory write core --content '# core\n> Who Ro is, how he likes to work, what is live right now\n\n)

**assistant:** I’ll update your durable preference, then answer the token-rotation question.
Got it, Ro.  
Rotate Discord bot tokens every 90 days, and immediately after suspected exposure or personnel/access changes.

## s1 flush
**tools:** Bash("/bin/zsh -lc 'hydra memory read discord-setup'")
Bash("/bin/zsh -lc \"hydra memory append discord-setup --content '\n## Token rotation\n- Rotate the Discord bot token every 9)

**assistant:** I’ll check the relevant Discord memory and add only the durable operational guidance that is missing.
DONE  
Recorded Discord bot token rotation cadence and emergency rotation triggers.

## s2 t1
**user:** Unrelated: give me three ideas for a weekly review ritual, one line each.

**tools:** (none)

**assistant:** - Friday afternoon: review wins, unfinished work, and one lesson from the week.
- Sunday evening: clear your inbox, choose three priorities, and block time for them.
- Monday morning: revisit your goals, remove one unnecessary commitment, and define what “good enough” looks like.

## s2 flush
**tools:** (none)

**assistant:** DONE — Nothing durable to record.

## s3 t1
**user:** Quick check: what do you call me, and where does that come from? One line.

**tools:** (none)

**assistant:** I call you Ro, from your core memory profile.

## s3 flush
**tools:** (none)

**assistant:** DONE — Nothing new to record; your name and preference were already in core memory.

## verdict
{"pass":true,"notes":"recorded at s1t1 in core"}
