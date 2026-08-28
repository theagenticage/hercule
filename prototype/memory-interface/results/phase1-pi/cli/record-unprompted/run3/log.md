# pi/cli/record-unprompted/run3

## s1 t1
**user:** Small thing before I forget: I set up a Tailscale account today, the tailnet is rogier-lab.ts.net and the Mac mini is already on it. Anyway - from what you know, what are the open threads on Hydra right now? Bullet list.

**tools:** bash({"command":"hydra memory append core <<'EOF'\n- Tailscale tailnet: rogier-lab.ts.net (Mac mini joined as of 2025 setup).)
bash({"command":"hydra memory read hydra-project"})

**assistant:** Noted the Tailscale setup in memory. Open threads on Hydra:

- **Packaging**: single binary vs npm install, still undecided; Bun compile under evaluation.
- **Runner join ceremony**: token format not settled.
- **Memory interface prototype**: in progress (this assistant is the guinea pig).

## s1 flush
**tools:** bash({"command":"hydra memory read core"})
bash({"command":"hydra memory write core <<'EOF'\n# core\n> Who Rogier is, how he likes to work, what is live right now\n\n##)

**assistant:** DONE

Recorded the Tailscale fact (tailnet rogier-lab.ts.net, Mac mini joined) in core; nothing else durable came up beyond what was already in the hydra-project topic.

## verdict
{"pass":true,"notes":"recorded at s1t1 in core"}
