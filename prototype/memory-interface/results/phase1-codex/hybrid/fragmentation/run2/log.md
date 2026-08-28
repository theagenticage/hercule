# codex/hybrid/fragmentation/run2

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,200p' memory/topics/hydra-project.md && hydra memory --help\"")
Bash("/bin/zsh -lc 'hydra memory append hydra-project --content $'\"'- Runner transport: the runner dials the controller over)

**assistant:** I’ll record this in Hydra’s project memory.
Noted in `hydra-project` memory.

## s1 flush
**tools:** (none)

**assistant:** DONE  
Nothing new to record; the websocket direction is already in `hydra-project` memory.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,200p' memory/topics/hydra-project.md && printf '\\\\n--- help ---\\\\n' && hydra memory --help)
Bash("/bin/zsh -lc 'hydra memory append hydra-project --content $'\"'## Facts\\\\n- The controller ships with an auto-joined )

**assistant:** I’ll add this to the Hydra project memory as a durable architecture fact.
Noted in `hydra-project`: the controller auto-joins a local runner, so single-machine installs work out of the box.

## s2 flush
**tools:** (none)

**assistant:** DONE  
Nothing new to record; the local-runner fact is already in `hydra-project`.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
