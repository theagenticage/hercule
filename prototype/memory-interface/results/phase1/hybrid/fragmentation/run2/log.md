# hybrid/fragmentation/run2

## s1 t1
**user:** Note for later: Hydra's runner dials the controller over a single websocket, never the other way round. That's all.

**tools:** Read({"file_path":"/private/tmp/claude-501/-Users-rogier-Dev-agentick-agentick-next/839a9e95-785c-4927-a4ab-7bacbf8fbd71/scra)
Bash({"command":"hydra memory write hydra-project <<'EOF'\n# hydra-project\n> Hydra architecture decisions, repo facts, open )

**assistant:** Got it, noted: the runner always dials the controller over a single websocket, connection direction never reverses. Added to the `hydra-project` memory topic.

## s1 flush
**tools:** (none)

**assistant:** DONE — nothing further to record; the websocket direction fact was already written to `hydra-project` earlier in this conversation.

## s2 t1
**user:** Another one for the notes: the controller ships with an auto-joined local runner, so a single-machine install just works. That's all.

**tools:** Bash({"command":"cat memory/topics/hydra-project.md"})
Bash({"command":"hydra memory append hydra-project --content \"- Controller ships with an auto-joined local runner, so a sing)

**assistant:** Noted in `hydra-project` memory.

## s2 flush
**tools:** (none)

**assistant:** DONE — nothing recorded, everything durable (auto-joined local runner fact) was already saved to `hydra-project` earlier in this session.

## verdict
{"pass":true,"notes":"both in hydra-project, no new topics"}
