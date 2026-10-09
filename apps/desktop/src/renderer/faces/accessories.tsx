import type { JSX } from "react";
import type { Accessory, Headwear } from "./look";
import { roundToHundredths } from "./shapes";

/**
 * Returns one accessory, drawn on top of the body as the Bureau book's
 * crew.js draws it. `topY` is the y of the top of the body: the homburg sits
 * relative to it, so one hat fits every shape. The other accessories sit at
 * the same place on every shape.
 *
 * The homburg and the bowtie are drawn in `--hat`, a near-black that works on
 * every hue and theme. The homburg's band is the wearer's own shade.
 */
export function drawAccessory(accessory: Accessory, topY: number): JSX.Element {
  switch (accessory) {
    case "homburg": {
      // Returns the y `dy` below the top of the body, rounded as crew.js rounds it.
      const computeHatY = (dy: number): number => roundToHundredths(topY + dy);
      // A dented crown, a band in the wearer's own shade and a brim curled up
      // at both ends.
      const crown =
        `M17 ${computeHatY(4.6)}` +
        `L17.5 ${computeHatY(-1.4)}` +
        `C17.7 ${computeHatY(-3.4)} 19.6 ${computeHatY(-3.9)} 21.2 ${computeHatY(-3.4)}` +
        `C22.5 ${computeHatY(-3)} 23 ${computeHatY(-2.3)} 24 ${computeHatY(-2.3)}` +
        `S25.5 ${computeHatY(-3)} 26.8 ${computeHatY(-3.4)}` +
        `C28.4 ${computeHatY(-3.9)} 30.3 ${computeHatY(-3.4)} 30.5 ${computeHatY(-1.4)}` +
        `L31 ${computeHatY(4.6)}z`;
      const band = `M17.2 ${computeHatY(1.8)}h13.6l.2 2.4H17z`;
      const brim =
        `M10.2 ${computeHatY(3.2)}` +
        `C11.2 ${computeHatY(5.9)} 15.6 ${computeHatY(6.8)} 24 ${computeHatY(6.8)}` +
        `S36.8 ${computeHatY(5.9)} 37.8 ${computeHatY(3.2)}` +
        `C36.2 ${computeHatY(4.7)} 31.2 ${computeHatY(5)} 24 ${computeHatY(5)}` +
        `S11.8 ${computeHatY(4.7)} 10.2 ${computeHatY(3.2)}z`;
      return (
        <>
          <path d={crown} fill="var(--hat)" />
          <path d={band} fill="var(--who-shade)" />
          <path d={brim} fill="var(--hat)" />
        </>
      );
    }
    case "tache":
      // Poirot's moustache: two full wings that thin out and curl up into
      // waxed points.
      return (
        <>
          <path
            d="M24 30.9c-1.5-1.3-4.2-1.5-5.8-.1-.9.8-2 .8-2.6-.3 0 1.9 1.6 3 3.5 2.6 1.9-.4 3.4-1 4.9-1.3 1.5.3 3 .9 4.9 1.3 1.9.4 3.5-.7 3.5-2.6-.6 1.1-1.7 1.1-2.6.3-1.6-1.4-4.3-1.2-5.8.1z"
            fill="var(--face-ink)"
          />
          <path
            d="M15.8 30.9c-.9-.3-1.3-1.2-.9-2M32.2 30.9c.9-.3 1.3-1.2.9-2"
            fill="none"
            stroke="var(--face-ink)"
            strokeWidth=".8"
            strokeLinecap="round"
          />
        </>
      );
    case "glasses":
      return (
        <g fill="none" stroke="var(--face-ink)" strokeWidth="1.15" opacity=".85">
          <circle cx="19" cy="26.6" r="4" />
          <circle cx="29" cy="26.6" r="4" />
          <path d="M23 26.2h2" />
        </g>
      );
    case "monocle":
      return (
        <>
          <circle
            cx="29"
            cy="26.6"
            r="4.2"
            fill="oklch(1 0 0 / .18)"
            stroke="var(--face-ink)"
            strokeWidth="1.2"
          />
          <path
            d="M32.4 29.2c1.4 2.6 1.6 5.6.6 8.8"
            fill="none"
            stroke="var(--brass)"
            strokeWidth=".9"
          />
        </>
      );
    case "bowtie":
      return (
        <>
          <path
            d="M24 38.6l-5.2-2.8c-.7-.4-1.4 0-1.4.8v4c0 .8.7 1.2 1.4.8zM24 38.6l5.2-2.8c.7-.4 1.4 0 1.4.8v4c0 .8-.7 1.2-1.4.8z"
            fill="var(--hat)"
          />
          <rect
            x="22.4"
            y="37"
            width="3.2"
            height="3.2"
            rx="1"
            fill="var(--hat)"
            stroke="var(--who)"
            strokeWidth=".7"
          />
        </>
      );
    case "watch":
      // A pocket watch on a brass chain.
      return (
        <>
          <path
            d="M24.4 37.2c2 1.4 4.8 1.6 7 .6"
            fill="none"
            stroke="var(--brass)"
            strokeWidth="1"
            strokeLinecap="round"
          />
          <circle cx="33.4" cy="37.8" r="2.7" fill="var(--brass)" />
          <circle cx="33.4" cy="37.8" r="1.7" fill="oklch(0.97 0.02 90)" />
          <path
            d="M33.4 36.9v.9l.6.4"
            stroke="var(--face-ink)"
            strokeWidth=".5"
            fill="none"
            strokeLinecap="round"
          />
        </>
      );
  }
}

/**
 * Returns an assistant's headwear, drawn on top of the body and its
 * accessories as the Bureau book's crew.js draws it. `topY` is the y of the
 * top of the body, as for `drawAccessory`: the cloche and the beret sit
 * relative to it, and the headset's band arches over it.
 *
 * Every piece is drawn in `--hat`; the cloche's band and rosette are the
 * wearer's own shade.
 */
export function drawHeadwear(headwear: Headwear, topY: number): JSX.Element {
  switch (headwear) {
    case "cloche": {
      // Returns the y `dy` below the top of the body, rounded as crew.js rounds it.
      const computeHatY = (dy: number): number => roundToHundredths(topY + dy);
      // A 1920s bell hat pulled down to the brows, with a rosette on the band.
      const bell =
        `M9.2 ${computeHatY(13.6)}` +
        `C9.6 ${computeHatY(3)} 15.4 ${computeHatY(-2)} 24 ${computeHatY(-2)}` +
        `S38.4 ${computeHatY(3)} 38.8 ${computeHatY(13.6)}` +
        `C35 ${computeHatY(11.4)} 30 ${computeHatY(10.6)} 24 ${computeHatY(10.6)}` +
        `S13 ${computeHatY(11.4)} 9.2 ${computeHatY(13.6)}z`;
      const band =
        `M10.2 ${computeHatY(9.4)}` +
        `C15.6 ${computeHatY(7)} 32.4 ${computeHatY(7)} 37.8 ${computeHatY(9.4)}`;
      const rosetteY = computeHatY(7.9);
      return (
        <>
          <path d={bell} fill="var(--hat)" />
          <path d={band} fill="none" stroke="var(--who-shade)" strokeWidth="2" />
          <circle cx="32.8" cy={rosetteY} r="2.4" fill="var(--who-shade)" />
          <circle cx="32.8" cy={rosetteY} r=".9" fill="var(--hat)" />
        </>
      );
    }
    case "beret": {
      // A beret tilted to one side, with its stalk on top. crew.js leaves
      // these two numbers unrounded.
      const crownY = topY + 1.8;
      return (
        <>
          <ellipse
            cx="22.6"
            cy={crownY}
            rx="12.6"
            ry="4.6"
            transform={`rotate(-9 22.6 ${crownY})`}
            fill="var(--hat)"
          />
          <path
            d={`M21.4 ${topY - 2.4}l.6-2.6`}
            stroke="var(--hat)"
            strokeWidth="1.8"
            strokeLinecap="round"
          />
        </>
      );
    }
    case "headset":
      // A band over the head, an earpiece on the left and a microphone on a
      // boom to the mouth. The band's control points sit 1 above the top of
      // the body, unrounded as in crew.js.
      return (
        <>
          <path
            d={`M9.4 26.4C9 ${topY - 1} 39 ${topY - 1} 38.6 26.4`}
            fill="none"
            stroke="var(--hat)"
            strokeWidth="1.9"
          />
          <rect x="6.2" y="23" width="5.6" height="9.2" rx="2.6" fill="var(--hat)" />
          <path
            d="M9.4 31.6c.6 3 3.2 4.8 7.4 5.2"
            fill="none"
            stroke="var(--hat)"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
          <circle cx="17.4" cy="36.8" r="1.7" fill="var(--hat)" />
        </>
      );
  }
}
