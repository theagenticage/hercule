# pi/files/fragmentation/run1

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** read({"path":"memory/topics/hydra-project.md"})
edit({"edits":[{"newText":"- Controller/runner split: runner dials the controller over a single websocket, never the other wa)

**assistant:** Noted and saved to `memory/topics/hydra-project.md`: the runner dials the controller over a single websocket, never the reverse.

## s1 flush
**tools:** (none)

**assistant:** DONE — nothing new to record; the websocket dialing note was already saved to `memory/topics/hydra-project.md` earlier this session.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** read({"path":"memory/topics/hydra-project.md"})
edit({"edits":[{"newText":"- Providers wrap Claude Code (Agent SDK), Codex app-server and pi. All three installed on the Mac )

**assistant:** Noted in `hydra-project`: controller ships with an auto-joined local runner, single-machine installs work out of the box.

## s2 flush
**tools:** (none)

**assistant:** DONE
Nothing new to record; the local-runner fact is already in `memory/topics/hydra-project.md`.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
