# Compare fonts: sources

Prototype only, never merged. Licence of every file: SIL OFL 1.1.

Four files are official Fontsource variable fonts (latin subset), fetched through jsDelivr from the
npm packages at a pinned version. Inter is the exception, and here is why: the Fontsource subset has
no `cv05`, `cv08` or `zero` (its GSUB features are only calt, ccmp, frac, locl, numr, dnom, pnum and
tnum). So the Inter file is the unmodified official release, which has all of them. Inter has no
Reserved Font Name. For the real font swap, subset it to latin with pyftsubset and keep cv05, cv08,
zero and tnum (about 69 KB, measured).

| File | URL | Version | Bytes | Axes |
|---|---|---|---|---|
| inter-4.1-variable.woff2 | https://github.com/rsms/inter/releases/download/v4.1/Inter-4.1.zip, entry `web/InterVariable.woff2` (zip sha256 9883fdd4a49d4fb66bd8177ba6625ef9a64aa45899767dde3d36aa425756b11e) | Inter 4.1, official release, unmodified | 352240 | opsz, wght |
| ibm-plex-sans-latin-wght-normal.woff2 | https://cdn.jsdelivr.net/npm/@fontsource-variable/ibm-plex-sans@5.3.0/files/ibm-plex-sans-latin-wght-normal.woff2 | @fontsource-variable/ibm-plex-sans 5.3.0 (Plex Sans 3.201) | 45712 | wght |
| geist-latin-wght-normal.woff2 | https://cdn.jsdelivr.net/npm/@fontsource-variable/geist@5.3.0/files/geist-latin-wght-normal.woff2 | @fontsource-variable/geist 5.3.0 (Geist 1.800) | 29400 | wght |
| jetbrains-mono-latin-wght-normal.woff2 | https://cdn.jsdelivr.net/npm/@fontsource-variable/jetbrains-mono@5.3.0/files/jetbrains-mono-latin-wght-normal.woff2 | @fontsource-variable/jetbrains-mono 5.3.0 (JetBrains Mono 2.211) | 40404 | wght |
| geist-mono-latin-wght-normal.woff2 | https://cdn.jsdelivr.net/npm/@fontsource-variable/geist-mono@5.3.0/files/geist-mono-latin-wght-normal.woff2 | @fontsource-variable/geist-mono 5.3.0 (Geist Mono 1.701) | 23128 | wght |
