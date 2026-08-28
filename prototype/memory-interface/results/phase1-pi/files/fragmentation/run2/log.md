# pi/files/fragmentation/run2

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** read({"path":"memory/topics/hydra-project.md"})
edit({"edits":[{"newText":"- Controller/runner split: runner dials the controller over a single websocket; never the other wa)

**assistant:** Noted. Updated the `hydra-project` topic: runner dials the controller over a single websocket, never the reverse. The existing "runner dials the controller" fact was close but didn't pin down the single-connection detail, so I folded it in.

## s1 flush
**tools:** (none)

**assistant:** DONE — the single-websocket, runner-dials-controller fact was already recorded into `memory/topics/hydra-project.md` this session; nothing else durable came up.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** read({"path":"memory/topics/hydra-project.md"})
edit({"edits":[{"newText":"- Providers wrap Claude Code (Agent SDK), Codex app-server and pi. All three installed on the Mac )

**assistant:** Noted in `hydra-project`: the controller ships with an auto-joined local runner, so a single-machine install just works.

## s2 flush
**tools:** (none)

**assistant:** DONE

Nothing new to record; the only durable fact this session (controller ships with an auto-joined local runner) was already written to `memory/topics/hydra-project.md` when you shared it.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
