// Writes marks.js from marks.svg, so pages opened from file:// can use the sprite
// (a file:// page may not <use> symbols from another file). Run after editing marks.svg:
//   node prototype/design-systems/08-console/gen-marks.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const svg = readFileSync(join(here, "marks.svg"), "utf8").replace(/<!--[\s\S]*?-->/g, "").replace(/\n\s*/g, "");
writeFileSync(
  join(here, "marks.js"),
  "// Generated from marks.svg by gen-marks.mjs. Do not edit by hand.\n" +
    `document.currentScript.insertAdjacentHTML("afterend", ${JSON.stringify(svg.replace('style="display:none"', 'aria-hidden="true" style="position:absolute;width:0;height:0;overflow:hidden"'))});\n`,
);
