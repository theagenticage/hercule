# codex/hybrid/fragmentation/run3

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,200p' memory/topics/hydra-project.md && printf '\\\\n--- core ---\\\\n' && sed -n '1,120p' mem)
Bash("/bin/zsh -lc 'hydra memory --help'")
Bash("/bin/zsh -lc 'hydra memory append hydra-project --content $'\"'\\\\n- Transport: the runner dials the controller over a)

**assistant:** I’m recording this in Hydra’s project memory so it persists for later sessions.
Noted in Hydra’s project memory: the runner initiates a single websocket connection to the controller; the controller never dials the runner.

## s1 flush
**tools:** (none)

**assistant:** DONE

Nothing new to record; the websocket direction is already in `hydra-project`.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,200p' memory/topics/hydra-project.md && hydra memory --help\"")
Bash("/bin/zsh -lc 'hydra memory append hydra-project --content $'\"'\\\\n- The controller ships with an auto-joined local ru)

**assistant:** I’ll add this durable Hydra architecture note to the existing project memory.
Noted in `hydra-project`: the controller auto-joins a local runner, so single-machine installs work out of the box.

## s2 flush
**tools:** (none)

**assistant:** DONE

Recorded nothing new; the local-runner note is already in `hydra-project`.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
