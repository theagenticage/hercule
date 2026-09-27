# Fonts in Console

Both families are licensed under the SIL Open Font License 1.1 (https://openfontlicense.org).
The files are the variable-weight WOFF2 builds from Fontsource, downloaded once and served
from this folder. The pages make no font requests to any other host.

| File | Family | Axes | Subset | Copyright | License | Source |
|---|---|---|---|---|---|---|
| `mona-sans-latin-wght.woff2` | Mona Sans | wght 200-900 | latin | Copyright 2023 The Mona Sans Project Authors (github.com/github/mona-sans) | OFL-1.1 | https://fontsource.org/fonts/mona-sans |
| `mona-sans-latin-ext-wght.woff2` | Mona Sans | wght 200-900 | latin-ext | as above | OFL-1.1 | as above |
| `jetbrains-mono-latin-wght.woff2` | JetBrains Mono | wght 100-800 | latin | Copyright 2020 The JetBrains Mono Project Authors (github.com/JetBrains/JetBrainsMono) | OFL-1.1 | https://fontsource.org/fonts/jetbrains-mono |
| `jetbrains-mono-latin-ext-wght.woff2` | JetBrains Mono | wght 100-800 | latin-ext | as above | OFL-1.1 | as above |

Why these two: Mona Sans carries the prose (proposal titles, transcripts, the gist of a
Proposal). JetBrains Mono carries everything you could type or read off a machine: keys,
counts, times, paths, commands, the status line. Its stems set the stroke weight of the
Console marks.

Glyphs outside these subsets (the arrows `→`, `⌘`, `⏎`, `⇧`, `⌥`) fall back to the
system's monospace font.
