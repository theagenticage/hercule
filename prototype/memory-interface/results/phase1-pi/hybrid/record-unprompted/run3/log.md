# pi/hybrid/record-unprompted/run3

## s1 t1
**user:** Small thing before I forget: I set up a Tailscale account today, the tailnet is rogier-lab.ts.net and the Mac mini is already on it. Anyway - from what you know, what are the open threads on Hydra right now? Bullet list.

**tools:** bash({"command":"hydra memory append core --content \"- Tailscale tailnet: rogier-lab.ts.net; Mac mini is on it.\""})
read({"path":"memory/topics/hydra-project.md"})

**assistant:** Noted the Tailscale detail in memory (core, "live right now").

Open threads on Hydra, as far as I know:

- **Packaging**: single binary vs npm install still undecided; Bun compile under evaluation.
- **Runner join ceremony**: token format not settled.
- **Memory interface prototype**: in flight, this assistant is the guinea pig.

One question back: does the Tailscale setup change the runner/controller connectivity picture? If runners will dial the controller over the tailnet, that might settle the join ceremony thread (or at least the transport part). Worth an ADR once you've decided.

## s1 flush
**tools:** (none)

**assistant:** DONE — Tailscale tailnet (rogier-lab.ts.net, Mac mini on it) was already recorded to core earlier this session; nothing else durable came up.

## verdict
{"pass":true,"notes":"recorded at s1t1 in core"}
