# codex/cli/recall-preference/run1

## s1 t1
**user:** Two things. First, from now on call me Ro - I don't like my full name in chats. Second, what's a sensible cadence for rotating Discord bot tokens? Two lines max.

**tools:** Bash("/bin/zsh -lc 'hydra memory read core'")
Bash("/bin/zsh -lc 'hydra memory write core --content $'\"'# core\\\\n> Who Rogier is, how he likes to work, what is live rig)

**assistant:** I’ll update your standing name preference, then answer the token-rotation question.
Ro, rotate Discord bot tokens every 90 days, and immediately after suspected exposure, access changes, or incidents.  
Automate reminders and store tokens in a secret manager.

## s1 flush
**tools:** Bash("/bin/zsh -lc 'hydra memory read discord-setup'")
Bash("/bin/zsh -lc 'hydra memory append discord-setup --content $'\"'\\\\n## Token rotation\\\\n- Rotate the Discord bot toke)

**assistant:** I’ll check the relevant Discord memory and add the token-rotation policy if it isn’t already captured.
DONE  
Recorded the Discord bot token rotation policy in `discord-setup`.

## s2 t1
**user:** Unrelated: give me three ideas for a weekly review ritual, one line each.

**tools:** (none)

**assistant:** - Sunday reset: review wins, unfinished tasks, and choose three priorities for the week.
- Friday debrief: note what worked, what drained you, and one experiment for next week.
- Monday compass: revisit your goals, clear your inbox, and schedule protected focus time.

## s2 flush
**tools:** (none)

**assistant:** DONE  
Nothing recorded; this conversation contained no durable information.

## s3 t1
**user:** Quick check: what do you call me, and where does that come from? One line.

**tools:** (none)

**assistant:** I call you Ro, from your memory profile.

## s3 flush
**tools:** (none)

**assistant:** DONE — Nothing new to record.

## verdict
{"pass":true,"notes":"recorded at s1t1 in core"}
