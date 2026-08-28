# pi/cli/record-unprompted/run2

## s1 t1
**user:** Small thing before I forget: I set up a Tailscale account today, the tailnet is rogier-lab.ts.net and the Mac mini is already on it. Anyway - from what you know, what are the open threads on Hydra right now? Bullet list.

**tools:** bash({"command":"hydra memory read hydra-project"})
bash({"command":"hydra memory read core"})
bash({"command":"hydra memory append core <<'EOF'\n- Tailscale tailnet: rogier-lab.ts.net; Mac mini is on it.\nEOF"})

**assistant:** Noted the Tailscale setup. Open threads on Hydra right now:

- **Packaging**: single binary vs npm install is still undecided; Bun compile is being evaluated.
- **Runner join ceremony**: token format not settled.
- **Memory interface prototype**: this assistant is the guinea pig for it.

## s1 flush
**tools:** bash({"command":"hydra memory read core | grep -i tailscale"})

**assistant:** DONE
The Tailscale fact (tailnet rogier-lab.ts.net, Mac mini joined) was already recorded in core during the session; nothing new to write.

## verdict
{"pass":true,"notes":"recorded at s1t1 in core"}
