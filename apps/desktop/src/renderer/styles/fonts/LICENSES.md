# Fonts used by Crew Bureau

Every family is a self-hosted woff2 file. Nothing is fetched at runtime. Limelight was downloaded once from fontsource's CDN; JetBrains Mono is copied unchanged from the `@fontsource-variable/jetbrains-mono` package; Inter is subset from the official release (see below).

| Family | Files | Used for | Axes used | Licence |
|---|---|---|---|---|
| Inter (The Inter Project Authors) | `inter-latin-variable-normal.woff2`, `inter-latin-ext-variable-normal.woff2` | All interface text, page titles included | wght 100-900, opsz 14-32 | SIL Open Font License 1.1 |
| Limelight (Nicole Fally, Sorkin Type) | `limelight-latin-400-normal.woff2` | The wordmark, the logo lettering and a few large numerals. Never body text | none (one weight) | SIL Open Font License 1.1 |
| JetBrains Mono (The JetBrains Mono Project Authors) | `jetbrains-mono-latin-wght-normal.woff2`, `jetbrains-mono-latin-ext-wght-normal.woff2` | Code blocks, diffs and commands only | wght 100-800 | SIL Open Font License 1.1 |

## Inter

Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter).

- Source: the official Inter 4.1 release, https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip
  - Zip sha256: `9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e`
  - Entry used: `web/InterVariable.woff2`, sha256 `693b77d4f32ee9b8bfc995589b5fad5e99adf2832738661f5402f9978429a8e3` (352,240 bytes)
- Why not fontsource's Inter: its subset drops the `cv05`, `cv08` and `zero` features the app turns on.
- Inter has no Reserved Font Name, so the subset keeps the name "Inter".
- Modification: the official file is cut to two sets of characters and nothing else changes. Both files keep the `wght` and `opsz` axes and the layout features of pyftsubset's default list (kerning, mark positioning, composition, contextual alternates), plus `cv05`, `cv08`, `zero` and `tnum`.
  - `inter-latin-variable-normal.woff2` (73,268 bytes, sha256 `63d0da133ba0135255e095729a67b6366805188fba9f3918fda282a055ffa789`) holds the characters of the `unicode-range` of the first `@font-face` of Inter in `tokens.css`.
  - `inter-latin-ext-variable-normal.woff2` (129,808 bytes, sha256 `78b2f29b4b61c8ccf85fc4f917b3ed58a03dc5b40d328400ab955dd268db764f`) holds those of the second one.
- Command (fontTools 4.67.0 with brotli), run once per file with its own `--unicodes` and `--output-file`:

```
pyftsubset InterVariable.woff2 \
  --unicodes=<the unicode-range of the @font-face, without spaces> \
  --flavor=woff2 --layout-features+=cv05,cv08,zero,tnum \
  --name-IDs='*' --notdef-outline \
  --output-file=inter-latin-variable-normal.woff2
```

`--layout-features+=` adds to pyftsubset's default list, so kerning, composition and mark positioning stay.

## Limelight

Copyright (c) 2011 by Sorkin Type Co (www.sorkintype.com), with Reserved Font Name "Limelight". The file is fontsource's unmodified latin file, so it keeps the name.

## JetBrains Mono

Copyright 2020 The JetBrains Mono Project Authors (https://github.com/JetBrains/JetBrainsMono).

- Source: the npm package `@fontsource-variable/jetbrains-mono` 5.3.0, https://registry.npmjs.org/@fontsource-variable/jetbrains-mono/-/jetbrains-mono-5.3.0.tgz
  - Tarball sha256: `996fe6368a480c9ce15d4de22a2682b7c40b403718fee2b15e7272f244fd993f`
  - Entries used, copied unchanged from `package/files/`:
    - `jetbrains-mono-latin-wght-normal.woff2` (40,404 bytes, sha256 `18be452724bfdc236c074ca94a249a7f41a86752c7d04ab258ce9ed5651f6a7e`) holds the characters of the `unicode-range` of the first `@font-face` of JetBrains Mono in `tokens.css`.
    - `jetbrains-mono-latin-ext-wght-normal.woff2` (15,196 bytes, sha256 `79bfdab9ba467e26eea4122e6f2567e188dd8a09a8c730d501fc487c4ab99c6e`) holds those of the second one.
  - The two `unicode-range` lists are the ones the package's `wght.css` declares for these files, so code with accented names keeps the font.
- Both files keep the `wght` axis. The Latin file has the `calt` feature, which joins `!=`, `===` and `->` into single glyphs; the app turns ligatures off for code (`font-variant-ligatures: none`).
- The files are fontsource's, so they keep the name "JetBrains Mono". The font has no Reserved Font Name.

The copyright lines of Limelight and JetBrains Mono are those of their `OFL.txt` in the google/fonts repository.

## Licence text

All three families are under the SIL Open Font License 1.1, whose official text is at https://openfontlicense.org/open-font-license-official-text/. This is the text as Inter ships it, with its copyright line:

```
Copyright (c) 2016 The Inter Project Authors (https://github.com/rsms/inter)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL

-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION AND CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
```
