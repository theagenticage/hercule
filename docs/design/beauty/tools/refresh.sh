#!/bin/bash
# Refreshes work/ and inbox/ from the clean builds' branches, keeping the two hook lines and leaving
# moves/ alone. Run from docs/design/beauty. The clean builds keep moving, and the study must match them.
set -e
root=$(git rev-parse --show-toplevel)
git -C "$root" fetch -q origin prototype/overview-hifi prototype/inbox-hifi
O=$(git -C "$root" ls-remote origin prototype/overview-hifi | cut -f1)
I=$(git -C "$root" ls-remote origin prototype/inbox-hifi | cut -f1)
tmp=$(mktemp -d)
git -C "$root" archive "$O" docs/design/overview docs/design/shared docs/design/work-views | tar -x -C "$tmp"
mkdir "$tmp/i"; git -C "$root" archive "$I" docs/design/inbox | tar -x -C "$tmp/i"
rsync -a --delete --exclude screens --exclude sketches --exclude tools --exclude index.html --exclude sheet.html --exclude story.js --exclude story.css "$tmp/docs/design/overview/" work/
rsync -a --delete --exclude screens --exclude sketches --exclude tools --exclude index.html --exclude story.js --exclude story.css "$tmp/i/docs/design/inbox/" inbox/
cp "$tmp/docs/design/shared/page.js" shared/page.js
cp "$tmp/docs/design/work-views/data.js" work-views/data.js
python3 - <<'P'
for v in ("work","inbox"):
    p=f"{v}/desktop.html"; s=open(p).read()
    s=s.replace('<script src="../shared/page.js"></script>','<script src="../shared/page.js"></script>\n<script src="../moves/boot.js"></script>',1)
    s=s.replace('</head>','<link rel="stylesheet" href="../moves/moves.css">\n</head>',1)
    s=s.replace('</body>','<script src="../moves/moves.js"></script>\n</body>',1)
    open(p,'w').write(s)
# The frame must take keyboard focus here, unlike a book's frames: the keys are part of the comparison.
p="shared/page.js"; s=open(p).read()
a=s.index("  // Inside a book or compare frame a page must not take focus")
b=s.index("})();",a)
open(p,'w').write(s[:a].rstrip()+"\n"+s[b:])
P
echo "$O" > .clean-overview; echo "$I" > .clean-inbox
rm -rf /tmp/beauty-clean; mkdir -p /tmp/beauty-clean; cp -r "$tmp/docs/design/overview" "$tmp/docs/design/shared" "$tmp/docs/design/work-views" /tmp/beauty-clean/; cp -r "$tmp/i/docs/design/inbox" /tmp/beauty-clean/inbox
rm -rf "$tmp"
echo "work $O, inbox $I"
