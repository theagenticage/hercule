# pi/files/fragmentation/run3

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** read({"path":"memory/topics/hydra-project.md"})
edit({"edits":[{"newText":"- Controller/runner split: controller owns domain state, runner owns material state. Runner dials )

**assistant:** Noted. I folded it into the existing controller/runner line in `memory/topics/hydra-project.md`: the runner dials the controller over a single websocket, never the other way round.

## s1 flush
**tools:** (none)

**assistant:** DONE. Nothing new to record; the runner-dials-controller-over-single-websocket fact was already written to `memory/topics/hydra-project.md` earlier this session.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** read({"path":"memory/topics/hydra-project.md"})
edit({"edits":[{"newText":"- Controller/runner split: controller owns domain state, runner owns material state. Runner dials )

**assistant:** Noted in `memory/topics/hydra-project.md`: the controller ships with an auto-joined local runner, so single-machine installs work out of the box. I left the "runner join ceremony" open thread alone since the token format for remote runners may still be unsettled - say the word if that's resolved too.

## s2 flush
**tools:** (none)

**assistant:** DONE - nothing new to record; the auto-joined local runner fact was already written to the hydra-project topic.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
