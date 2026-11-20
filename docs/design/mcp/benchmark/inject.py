"""Writes the numbers `summarize.py --json` produced into the page.

Usage: python3 -I inject.py <results.json> <index.html>

Replaces what stands between the two markers in the page's script, so the
page needs no network and no build step to show the measurement.
"""

import json
import re
import sys

results = json.load(open(sys.argv[1]))
page = open(sys.argv[2]).read()
page, count = re.subn(
    r"/\*RESULTS-BEGIN\*/.*?/\*RESULTS-END\*/",
    lambda _: "/*RESULTS-BEGIN*/" + json.dumps(results, separators=(",", ":")) + "/*RESULTS-END*/",
    page,
    flags=re.S,
)
if count != 1:
    raise SystemExit("the page has no RESULTS markers")
open(sys.argv[2], "w").write(page)
