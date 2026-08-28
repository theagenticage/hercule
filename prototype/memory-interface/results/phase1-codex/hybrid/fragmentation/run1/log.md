# codex/hybrid/fragmentation/run1

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,160p' memory/topics/hydra-project.md && hydra memory --help\"")
Bash("/bin/zsh -lc 'hydra memory append hydra-project --content $'\"'\\\\n- Transport: the runner initiates a single websocke)

**assistant:** I’ll add this to Hydra’s project memory so it remains available in future sessions.
Noted in `hydra-project` memory: the runner initiates a single websocket connection to the controller.

## s1 flush
**tools:** (none)

**assistant:** DONE  
Nothing new recorded; the websocket transport fact is already in `hydra-project`.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,200p' memory/topics/hydra-project.md && hydra memory --help\"")
Bash("/bin/zsh -lc 'hydra memory append hydra-project --content $'\"'- Controller ships with an auto-joined local runner, so )

**assistant:** I’ll add this durable architecture note to the Hydra project memory.
Noted in `hydra-project` memory: the controller auto-joins a local runner, making single-machine installs work out of the box.

## s2 flush
**tools:** (none)

**assistant:** DONE  
Nothing new recorded; the local-runner note is already in `hydra-project`.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
