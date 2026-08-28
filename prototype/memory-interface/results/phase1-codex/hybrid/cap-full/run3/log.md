# codex/hybrid/cap-full/run3

## s1 t1
**user:** Three updates on Hydra, please make sure they stick: (1) we are going with Bun to compile the single binary, (2) ADR 0018 on packaging is merged, (3) runner join tokens are single-use, that is now final. Then tell me how many ADRs you know about, number only.

**tools:** Bash("/bin/zsh -lc \"sed -n '1,240p' memory/topics/hydra-project.md && printf '\\\\n--- files ---\\\\n' && rg --files docs/ad)
Bash("/bin/zsh -lc 'rg -n -i \"ADR|packag|single-use|join token|Bun\" memory docs 2>/dev/null | head -200'")
Bash("/bin/zsh -lc 'hydra memory --help && hydra memory write --help'")
Bash("/bin/zsh -lc \"hydra memory write hydra-project --content \\\"# hydra-project\\\\n> Hydra architecture decisions, repo )
Bash("/bin/zsh -lc \"hydra memory read hydra-project | sed -n '1,80p' && hydra memory list\"")
Bash("/bin/zsh -lc \"hydra memory write hydra-project <<'EOF'\n# hydra-project\n> Hydra architecture decisions, repo facts, o)

**assistant:** I’ll update the relevant durable memory entries, replacing any superseded packaging and runner-token decisions, then count the ADRs represented in memory.
I found the Hydra project memory entry. It had stale “undecided” packaging and “not settled” token wording, while already recording six distinct decision topics only if packaging is added as ADR 0018. I’m consolidating that entry so the final state is explicit and old wording is removed.
The first write exposed a CLI quirk: `--content` stored literal `\n` characters, so the document structure was not recognized. I’m correcting it through the CLI’s stdin heredoc path, then I’ll verify the saved entry and count.
6

## s1 flush
**tools:** (none)

**assistant:** DONE

Nothing new recorded.

## verdict
{"pass":true,"notes":"facts 3/3; hydra-project 2637 chars (was 11824); stub rejects 0; new topics none"}
