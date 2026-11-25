# Attribution

Third-party material that is copied into this repository. Each entry says what is copied, from where, under which licence, and where the licence text is. The licence texts stay beside the material; this file only points to them.

## T3 Code: the ACP client

- What: `packages/effect-acp` of [T3 Code](https://github.com/pingdotgg/t3code), copied unchanged to `packages/acp/vendor/effect-acp/`. Commit `3a63e0ca37a50d31f78b0188960557ff69964e76`. How it is kept: `packages/acp/README.md`.
- Licence: MIT. Copyright (c) 2026 T3 Tools Inc.
- Text: `packages/acp/vendor/effect-acp/LICENSE`

## Octicons: status icons of the GitHub plugin

- What: the paths of six icons (pull request open, draft, merged and closed; issue open and closed) from [primer/octicons](https://github.com/primer/octicons), package `@primer/octicons` 19.15.0, copied unchanged into `plugins/github/src/status-icons.ts`.
- Licence: MIT. Copyright (c) 2025 GitHub Inc.
- Text: `plugins/github/src/LICENSE-octicons.txt` (it also lists which file became which constant).

## LobeHub icons: harness and provider marks

- What: the marks of Claude, OpenAI and Antigravity in `packages/ui/src/logos/marks.ts`, copied unchanged from [lobehub/lobe-icons](https://github.com/lobehub/lobe-icons). The OpenCode and MiniMax marks in `plugins/opencode/src/index.ts` and `plugins/minimax/src/index.ts` come from the same set, scaled from a 24x24 to a 16x16 box. Commits and package versions: the text file below.
- Licence: MIT. Copyright (c) 2023 LobeHub.
- Text: `packages/ui/src/logos/LICENSE-lobehub.txt`

## Fonts of the web app

- What: Onest and IBM Plex Mono, as woff2 files in `packages/ui/src/fonts/`.
- Licence: SIL Open Font License 1.1. Onest: Copyright 2021 The Onest Project Authors. IBM Plex Mono: Copyright (c) 2017 IBM Corp., with Reserved Font Name "Plex".
- Text: `packages/ui/src/fonts/OFL-Onest.txt` and `packages/ui/src/fonts/OFL-IBMPlexMono.txt`

## Fonts of the desktop app

- What: Inter (subset of the official 4.1 release), Limelight and JetBrains Mono, as woff2 files in `apps/desktop/src/renderer/styles/fonts/`. Sources, hashes and changes: the file below.
- Licence: SIL Open Font License 1.1. Copyright (c) 2016 The Inter Project Authors; Copyright (c) 2011 Sorkin Type Co, with Reserved Font Name "Limelight"; Copyright 2020 The JetBrains Mono Project Authors.
- Text: `apps/desktop/src/renderer/styles/fonts/LICENSES.md` (it holds the OFL text as Inter ships it and names the official text at https://openfontlicense.org/open-font-license-official-text/).

## Fonts and libraries of the Android app

- What: Bricolage Grotesque, Limelight and Recursive (fonts), the commonmark-java library, and the marked rules the markdown port follows. The licence files are the app's bundled assets.
- Licence: SIL Open Font License 1.1 for the three fonts, BSD 2-Clause for commonmark-java (Copyright (c) 2015, Atlassian Pty Ltd), MIT for marked (Copyright (c) 2018+ MarkedJS; Copyright (c) 2011-2018 Christopher Jeffrey).
- Text, in `apps/android/app/src/main/assets/licenses/`: `bricolage-grotesque-OFL.txt`, `limelight-OFL.txt`, `recursive-OFL.txt`, `commonmark-java-BSD-2.txt`, `marked-MIT.txt`

## Fonts of the design studies

- What: Bricolage Grotesque, Limelight and Recursive, as the woff2 files of the three design studies. Each study's file names the families it holds.
- Licence: SIL Open Font License 1.1. The files below name each family and its authors and point to the official licence text at https://openfontlicense.org/open-font-license-official-text/.
- Text: `docs/design/c0-crew/fonts/LICENSES.md`, `docs/design/crew-bureau/fonts/LICENSES.md`, `docs/design/crew-bureau-2/fonts/LICENSES.md`
