# Research: which rendering techniques draw the Office on almost no power

Ticket: [#333](https://github.com/theagenticage/hercule/issues/333), for the map [Office v1 in the desktop app (#332)](https://github.com/theagenticage/hercule/issues/332).
Date: 2026-10-03.
Spike branch: `spike/office-rendering` (local only, not pushed), on top of `prototype/office-3d`.

The question: which rendering techniques let the 3D Office draw on almost no CPU and GPU, in Electron on a Mac? And how do we measure that cost the same way every time?

## The answer in short

- **Three things decide almost everything:**
  1. **No frames while nobody looks.** A hidden or covered window already draws nothing. Chromium does this on its own, as long as `backgroundThrottling` stays on.
  2. **Standing still.** When nothing happens, the Office draws no frames at all. That is 0% CPU and 0 wakeups. Use it on battery.
  3. **At most 30 frames a second for ambient life.** The prototype draws at 88. Capping it cuts the CPU cost to about a third.
- **Then the cost of one frame:**
  - **Glass over the canvas.** `backdrop-filter` costs the GPU process 14-19 points of one core.
  - **Ambient occlusion (GTAO).** It draws the scene a second time, and costs 4-8 points in each process.
  - **The number of draw calls.** It matters most at Ten times.
- **Recommended for v1** (Today's fleet, camera at rest; % of one core, renderer / GPU process; all measured). These are the settings spec 17 on `spec/office-v1` now fixes: pixel ratio 2, no ambient occlusion, sun shadows drawn once, and no blur while the Office is open.

  | Step | Renderer | GPU process |
  |---|---|---|
  | The prototype as it is (88 fps, High, glass on) | 45 | 85 |
  | + 30 fps cap | 16 | 31 |
  | + no glass over the canvas | 14 | 12 |
  | + no ambient occlusion, sun shadows drawn once (the v1 settings) | 9 | 8 |
  | Standing still (on battery, between happenings) | 0 | 0 |

  That is about 17 points of one core in total, against 130 today. It takes a few hours to build. The fourth row comes from a later session; within that session, the same step took High without glass from 16.6 / 15.2 to 9.1 / 7.7.
- **Glass, if it comes back:** the v1 settings with all of the prototype's glass read 7.9 / 21.8, and with glass on the top bar only 9.2 / 11.6. Glass on the top bar alone costs about a quarter of all the glass.
- **For later:** merging the building's meshes (it matters at Ten times), the building cached into a texture, instanced skinned characters, impostors and LOD, and baked light.
- **Measured, not estimated:** every number in the tables below, on one M4 Max. The main tables ran each row twice, interleaved; the rest ran once, and each table says which. Estimates are marked as estimates.

## How to read the numbers

- **The machine:**
  - Apple M4 Max, 16 logical CPUs, macOS 15.8, Electron 44.4.5 (Chromium 152);
  - the built-in display at 120 Hz, on AC power;
  - load average between 3.9 and 7.6, from other work on the machine. The later sessions were quieter than the first, so each table says which session it comes from, and the second session repeats two rows of the first as a bridge.
- **The window** is 1440 x 900 points on the built-in display. The canvas is 2336 x 1744 pixels at pixel ratio 2.
- **The scene** is the prototype's Bureau floor:
  - Calm liveliness, day light, Smart name tags, Bean characters;
  - the event flow off (`flow=0`), so the capsules do not move;
  - quality High unless the row says otherwise.
- **The fleets:**
  - Today: 16 sessions;
  - Ten times: 142 sessions.
- **CPU is in % of one core.** 100 means one core busy all the time. "Renderer" is the page's process. "GPU process" is Chromium's process that draws the window and talks to the GPU. The browser process stayed between 0.2 and 2% in every run, so the tables leave it out.
- **Wakeups** are interrupt wakeups a second, the number Activity Monitor shows.
- **GPU time** is the GPU's own time for one frame, from a timer query. It is only comparable between runs at the same frame rate, because the GPU clocks down when it has little to do.
- **Spread.** Two runs of the same row differed by up to about 2 points of CPU. A difference smaller than that is noise.
- **A slower Mac costs more.** A MacBook Air has a much smaller GPU. Its GPU time per frame will be several times higher. The ranking should hold; the absolute numbers will not.

## The ranked list

Ranked by what each saves on its own, at Today's fleet, from the prototype as it is. "Build" is a rough estimate of the work to take it into v1.

| # | Technique | Saves (measured unless marked) | Costs | Build |
|---|---|---|---|---|
| 1 | No frames while hidden, minimized or covered | Everything: 0% and 0 wakeups, hidden and covered. Minimized not measured | Nothing, if `backgroundThrottling` stays on and frames come from rAF | Already true |
| 2 | Stand still when nothing happens (on battery) | Everything between happenings: 0% and 0 wakeups | Colleagues freeze between happenings | 1 hour, with `navigator.getBattery()` |
| 3 | 30 fps cap for ambient life | 45 → 16 renderer, 85 → 31 GPU process (about 130 → 47) | Ambient motion is less smooth; the camera can still glide at full rate | Under 1 hour |
| 4 | No `backdrop-filter` over the canvas | 14-19 points of the GPU process (31 → 12 at High; 21.8 → 7.7 at the v1 settings). Glass on the top bar only costs about 4 | The top bar and room labels lose their glass; use a solid fill | Under 1 hour |
| 5 | No live ambient occlusion | Renderer 16.6 → 9.2, GPU process 15.2 → 7.6 (in one session); draw calls 1800 → 900; GPU time 8.4 → 4.9 ms | Less contact darkness in corners and under desks | Minutes |
| 6 | Sun shadows drawn once, not every frame | With AO: renderer about -1.5, GPU process about -1.3, draw calls 1803 → 1149. Without AO: 0 to -2, within the spread; draw calls 900 → 573 | Colleagues cast no sun shadow, unless blob shadows are added | Under 1 hour, plus blob shadows |
| 7 | Merging static meshes by material | At Today: renderer about -2. At Ten times: renderer 25 → 15, draw calls 2620 → 598 (with static shadows) | Memory (see below), coarser frustum culling; walls that drop away need care | Half a day to a day |
| 8 | The building cached into colour and depth textures | At High's look: renderer 14 → 7, GPU process 12 → 5.5, 51 draw calls, GPU time 0.6 ms | Redraws every frame while the camera moves or follows a colleague; colleagues lose sun shadow and AO; every change must invalidate the cache | 1-2 days |
| 9 | Lower pixel ratio | Pixel ratio 1 at High: GPU time per frame -28%; CPU unchanged | A softer picture on Retina | Minutes |
| 10 | Sim and skeletons at 15 Hz | Nothing measurable at Today (8.7 vs 9.9, within noise) | Choppier motion | Not worth it |
| 11 | `powerPreference: "low-power"` | Nothing (13.9 / 12.0 vs 14.1 / 12.1). Apple silicon has one GPU | None | Not worth it |
| 12 | rAF that skips frames vs a timer loop | No difference: all three loops read 14-16 / 29-31 | | Keep rAF |
| - | Instanced skinned characters | Estimated: a few ms of JavaScript a frame at Ten times; little at Today | A new dependency or a custom shader | 1-2 days |
| - | Impostors and LOD | Estimated: GPU vertex work; little CPU | Art and tuning | Days |
| - | Baked light, shadows and AO | Estimated: like the cache, without its redraws | A bake per theme, light and layout change; needs UV unwraps | Days |

## The v1 combination

**Build now:**

1. **Frames from `requestAnimationFrame`, capped at 30 a second for ambient life.** Skip a rAF when less than about 29 ms passed since the last drawn frame. While the camera moves, draw every rAF, or at most 60 a second as spec 17 now says.
2. **Stand still on battery.** Read `navigator.getBattery()` in the renderer; `charging === false` means on battery. Listen for `chargingchange`. While standing still, draw only when something happens (a pose change, a walk, the camera) and stop the rAF loop once it settles.
3. **No ambient occlusion.**
4. **Sun shadows drawn once,** and again only when the building, the light or the theme changes. Optionally a blob shadow under each colleague.
5. **Keep `backgroundThrottling` on,** and keep the loop on rAF, so hidden and covered windows cost nothing.
6. **No glass over the canvas.** Spec 17 on `spec/office-v1` now decides this: the window draws no blur while the Office is open.
7. **Pixel ratio 2,** as spec 17 fixes it. Pixel ratio 1.5 (the prototype's Medium) measured no cheaper in CPU (8.8 / 7.2 against 9.2 / 7.6 in one session).

Expected, measured as "v1" in the later-session table below: renderer about 9 and GPU process about 8 at Today's fleet, at 30 fps, camera at rest. All of the prototype's glass would add about 14 to the GPU process; glass on the top bar only, about 4. At Ten times: renderer about 21 and GPU process about 15 (one run). Merging the building is the next step there.

**Leave for later, in this order:**

1. **Merging or `BatchedMesh` for the building,** before the fleet grows. At Ten times it halves the renderer's cost.
2. **The building cache,** to get High's look (AO, pixel ratio 2) for less than Medium costs today.
3. **Instanced skinned characters,** when fleets reach Ten times.
4. **Impostors and LOD, baked light:** only if a slower Mac needs them.

**One more idea, not measured:** after some minutes without input, settle to Still even on AC. A visible Office that nobody watches would then cost nothing.

## Measured results

### Today's fleet (16 sessions)

All at High quality, glass off, 30 fps cap from rAF, unless the row says otherwise. Two rounds each, interleaved; the mean is shown.

| Row | fps | Renderer % | GPU process % | Renderer wakeups/s | GPU wakeups/s | JS ms/frame | GPU ms/frame | Draw calls | Working set MB |
|---|---|---|---|---|---|---|---|---|---|
| Blank window (the floor) | 0 | 0 | 0 | 0 | 1.5 | - | - | - | 319 |
| The prototype: no cap, glass on | 87.9 | 45.4 | 84.8 | 110 | 352 | 4.2 | 8.5 | 1803 | 787 |
| Cap (rAF that skips), glass on | 30.0 | 16.4 | 31.3 | 64 | 315 | 3.7 | 7.5 | 1803 | 765 |
| Cap (timer, then rAF), glass on | 29.0 | 14.2 | 29.6 | 65 | 315 | 3.6 | 7.6 | 1803 | 755 |
| Cap (timer only), glass on | 29.1 | 13.9 | 29.3 | 59 | 311 | 3.5 | 7.5 | 1803 | 752 |
| Cap | 30.0 | 14.1 | 12.1 | 66 | 432 | 3.4 | 8.3 | 1803 | 729 |
| `powerPreference: "low-power"` | 30.1 | 13.9 | 12.0 | 70 | 418 | 3.2 | 8.5 | 1803 | 732 |
| Pixel ratio 1 | 30.1 | 14.2 | 11.8 | 65 | 368 | 3.4 | 6.0 | 1803 | 729 |
| Sun shadows drawn once | 30.0 | 12.7 | 10.8 | 71 | 414 | 2.8 | 7.8 | 1149 | 731 |
| Merged | 30.1 | 12.1 | 12.2 | 61 | 413 | 2.4 | 8.4 | 777 | 857 |
| Medium (no AO, pixel ratio 1.5, 2048 shadow map) | 29.9 | 9.9 | 7.9 | 68 | 329 | 2.1 | 3.1 | 900 | 727 |
| Medium, again | 30.0 | 9.0 | 7.2 | 68 | 362 | 1.9 | 3.8 | 900 | 727 |
| Medium, sim and skeletons at 15 Hz | 29.9 | 8.7 | 7.3 | 72 | 364 | 1.9 | 4.1 | 900 | 726 |
| Medium, merged, shadows once | 30.1 | 8.1 | 6.8 | 65 | 329 | 1.4 | 2.8 | 233 | 856 |
| Building cache (High's look) | 30.1 | 7.3 | 5.5 | 68 | 287 | 1.2 | 0.6 | 51 | 725 |
| Building cache, merged | 30.0 | 6.6 | 4.9 | 62 | 288 | 1.1 | 0.8 | 51 | 860 |
| Evening light, Medium | 30.1 | 9.4 | 7.8 | 67 | 403 | 2.0 | 6.1 | 901 | 732 |
| Evening light, building cache | 30.1 | 6.4 | 4.8 | 66 | 284 | 1.0 | 1.0 | 51 | 723 |
| Still liveliness, glass on | 0 | 0 | 0 | 0 | 0 | - | - | - | 754 |
| Still liveliness, glass off | 0 | 0 | 0 | 0 | 0 | - | - | - | 740 |

What the table shows:

- **Wakeups barely move with the cost of a frame.** Every 30 fps row wakes the renderer about 60-70 times a second and the GPU process about 290-430 times. Only standing still brings them to 0. The display link runs at 120 Hz while anything asks for frames.
- **The GPU process's wakeups rise when its CPU falls** (glass off: 432 wakeups at 12%, glass on: 315 at 31%). Wakeups count interrupts, not work.
- **Evening light** doubles the GPU time per frame at Medium (3 → 6 ms), from the lamps' point lights. The CPU does not change.
- **Working set** grows by about 130 MB with merging. The spike keeps the original meshes' geometry after merging, so part of that rise is the spike's, not merging's. A real merge would dispose of the originals.

### Today's fleet, later sessions: the v1 settings and the glass

Two later sessions measured the settings spec 17 fixes for v1 (pixel ratio 2, no AO, sun shadows drawn once) and the glass. Glass off and 30 fps cap from rAF unless the row says otherwise.

- **21:58-22:04:** each row twice, interleaved; the mean is shown.
- **21:21-21:24:** "High, no AO" twice; the other two rows once.

The first two rows of the 21:58 session repeat rows of the table above, as a bridge. "High, AO" read 2-3 points higher than in the first session, and Medium about 1 point lower. So compare rows within one session, not across sessions.

| Row | fps | Renderer % | GPU process % | Renderer wakeups/s | GPU wakeups/s | JS ms/frame | GPU ms/frame | Draw calls | Working set MB |
|---|---|---|---|---|---|---|---|---|---|
| **21:58 session** | | | | | | | | | |
| High, AO (the "Cap" row above) | 30.0 | 16.6 | 15.2 | 73 | 419 | 3.7 | 8.4 | 1800 | 734 |
| Medium (as above) | 30.0 | 8.8 | 7.2 | 69 | 386 | 1.9 | 4.4 | 900 | 727 |
| High, no AO | 30.0 | 9.2 | 7.6 | 69 | 403 | 1.9 | 4.9 | 899 | 737 |
| v1: High, no AO, shadows once | 30.0 | 9.1 | 7.7 | 66 | 389 | 1.8 | 4.7 | 573 | 481-779 |
| v1, glass on the top bar only | 30.0 | 9.2 | 11.6 | 68 | 290 | 1.8 | 4.5 | 573 | 777 |
| v1, all glass on | 30.0 | 7.9 | 21.8 | 61 | 294 | 1.6 | 4.0 | 570 | 786 |
| **21:21 session** | | | | | | | | | |
| High, no AO | 30.0 | 8.5 | 6.8 | 65 | 389 | 2.0 | 4.9 | 900 | 729 |
| v1: High, no AO, shadows once (once) | 30.0 | 6.7 | 5.6 | 66 | 351 | 1.5 | 4.5 | 573 | 724 |
| v1, merged (once) | 30.0 | 5.2 | 4.4 | 74 | 373 | 1.0 | 4.6 | 233 | 847 |

What the table shows:

- **AO is the biggest cost of a frame** once the cap and the glass are dealt with: 16.6 / 15.2 with it, 9.2 / 7.6 without, in this session.
- **Pixel ratio 2 costs no more CPU than 1.5.** High without AO and Medium read the same in both processes. Only the GPU time differs (4.9 against 4.4 ms).
- **Shadows drawn once save little without AO.** 9.2 / 7.6 against 9.1 / 7.7 in one session, 8.5 / 6.8 against 6.7 / 5.6 (one run) in the other. The draw calls fall from 900 to 573 either way.
- **The v1 row's two runs spread more than the others:** renderer 7.6-10.6, GPU process 6.5-8.9. The working set read 481 MB in one run and 779 MB in the other; the reason is unknown.
- **Glass on the top bar only costs about 4 points,** against 14 for all of the glass. See "Glass over the canvas".

### Ten times fleet (142 sessions)

One run each, so the spread is unknown; read differences under 2 points as noise. Glass off and 30 fps cap from rAF unless the row says otherwise.

| Row | fps | Renderer % | GPU process % | Renderer wakeups/s | GPU wakeups/s | JS ms/frame | GPU ms/frame | Draw calls | Working set MB |
|---|---|---|---|---|---|---|---|---|---|
| The prototype: no cap, glass on | 63.0 | 102 | 109 | 49 | 436 | 15.6 | 8.2 | 5243 | 949 |
| Cap, glass on | 30.0 | 52.2 | 58.4 | 56 | 347 | 15.2 | 7.7 | 5243 | 934 |
| Cap | 30.1 | 53.1 | 35.3 | 63 | 379 | 15.6 | 7.8 | 5243 | 896 |
| Medium | 30.0 | 25.3 | 16.6 | 49 | 346 | 6.8 | 3.6 | 2620 | 885 |
| Medium, merged, shadows once | 30.1 | 14.6 | 10.3 | 66 | 373 | 3.6 | 4.5 | 598 | 1292 |
| Medium, merged, shadows once, sim at 15 Hz | 30.0 | 14.6 | 11.0 | 64 | 383 | 3.6 | 5.0 | 598 | 1284 |
| Building cache (High's look), merged | 30.0 | 17.9 | 9.4 | 61 | 316 | 4.7 | 2.5 | 350 | 1290 |
| v1: High, no AO, shadows once (21:58 session) | 30.0 | 21.4 | 14.9 | 70 | 400 | 5.4 | 5.3 | 1648 | 891 |
| v1, all glass on (21:58 session) | 30.0 | 18.8 | 31.4 | 76 | 313 | 4.9 | 3.9 | 1648 | 923 |

What the table shows:

- **At Ten times the renderer's JavaScript is the cost.** At High, a frame takes 15.6 ms of JavaScript, and the uncapped prototype manages only 63 fps. The 30 fps cap still halves the cost.
- **Merging matters here,** unlike at Today's fleet: Medium alone is 25 / 17, merged with shadows drawn once it is 15 / 10.
- **The building cache does not help at Ten times.** 142 colleagues are about 300 draw calls of their own, so drawing only the colleagues is no longer cheap. Instanced skinned characters are what would help next.
- **Merging's memory** shows clearly here: about +400 MB of working set. Part of that is the spike keeping the original geometry (see "The spike").

### While the camera moves

The harness turns the building 45 degrees every 0.9 seconds (the Q key), so the camera glides most of the time.

One run each. The spike caps these frames at 30 too; v1 allows up to 60 while the camera moves, which would cost about twice as much while it moves (estimated). Glass off unless the row says otherwise.

| Row | fps | Renderer % | GPU process % | Renderer wakeups/s | GPU wakeups/s | JS ms/frame | GPU ms/frame | Draw calls | Cache redraws/s |
|---|---|---|---|---|---|---|---|---|---|
| Medium | 30.0 | 10.1 | 6.8 | 85 | 391 | 1.8 | 4.4 | 882 | - |
| Medium, merged, shadows once | 30.0 | 9.3 | 6.5 | 74 | 390 | 1.2 | 4.3 | 346 | - |
| Building cache (High's look) | 30.0 | 12.6 | 7.5 | 73 | 389 | 2.6 | 4.5 | 859 | 30 |
| Building cache, merged | 30.0 | 10.7 | 6.8 | 77 | 385 | 1.8 | 4.4 | 346 | 30 |
| v1, all glass on (21:58 session) | 30.1 | 11.9 | 43.4 | 82 | 398 | 1.9 | 3.6 | 856 | - |

What the table shows:

- **While the camera moves, the building cache is drawn again every frame** (30 redraws a second). It then costs more than at rest (12.6 against 7.3 for the renderer), and no less than drawing without a cache.
- **Medium costs about the same moving as at rest.** Without a cache, every frame draws everything anyway.

### Window states

Glass on, High, 30 fps cap, Today's fleet. "Covered" is a full-screen window of the same app on top. "Another window focused" is a small window of the same app beside the Office, with the focus.

The window-state runs were one run each, in an earlier, quieter session (the browser process read 0.2-0.4%), so the visible row reads a little lower than in the Today table above:

| Window state, loop | Renderer % | GPU process % | Renderer wakeups/s | GPU wakeups/s | `visibilityState` | `hasFocus()` |
|---|---|---|---|---|---|---|
| Visible, rAF | 15.5 | 29.7 | 61 | 340 | `visible` | true |
| Visible, another window focused, rAF | 15.0 | 29.7 | 61 | 324 | `visible` | false |
| Hidden, rAF | 0 | 0 | 0 | 0 | `hidden` | |
| Hidden, timer loop | 0 | 0 | 0 | 0 | `hidden` | |
| Covered, rAF | 0.1 | 0 | 0 | 4 | `hidden` | |
| Covered, timer loop | 0.1 | 0 | 1 | 0 | `hidden` | |

- **A timer loop in a hidden window** also cost nothing, because the spike's timer loop stops itself while `document.hidden` is true. A timer loop without that check would keep waking up to once a second, Chromium's limit for hidden timers (from the source, not measured).
- **Minimized:** the harness called `minimize()`, but the window stayed on screen and drew at 30 fps. That run measured nothing about minimized windows.

## The techniques

### Frame rate: the 30 fps cap and standing still

- **What it is.** The prototype draws on every rAF while anything moves, and Calm's breathing always moves, so it draws at the display's rate: 88 a second here, limited by its own cost.
- **What it saves.** Capping at 30 cuts the CPU cost to about a third, for both processes. Standing still cuts it to zero.
- **What it does not save.** Wakeups. A 30 fps Office wakes the renderer about 65 times a second and the GPU process about 300, at any cost per frame. Spec 17's idle budget (renderer no wakeups, GPU at most 12 a second) can only be met by standing still.
- **How.** A rAF loop that skips a frame when less than about 29 ms passed since the last one. Never a `setInterval`: rAF stops on its own in a hidden window; a timer keeps waking once a second.

### Glass over the canvas

- **What it saves (measured).** All `backdrop-filter` off, at 30 fps, camera at rest:
  - at High with AO: the GPU process falls from 31 to 12 points;
  - at the v1 settings: from 21.8 to 7.7.
  - The renderer does not change.
- **While the camera moves, glass costs far more.** The v1 settings with all glass read 43.4 in the GPU process while the camera glides (one run). Every frame then changes the whole picture under every blur. No run without glass was made in that session; Medium without glass read 6.8 while moving in an earlier one.
- **Why it costs so much (from Chromium's source, not measured).** On macOS, Chromium can hand the canvas and the page's layers to the window server as CALayers, and then composite nothing itself. Apple offers no partial hand-off. One element anywhere in the window that cannot be a CALayer makes Chromium composite the whole window on the GPU, every frame. `backdrop-filter` is one such element. So are blend modes, masks, non-uniform corner radii, `preserve-3d`, and more than 30 render passes.
- **Where the glass is.** In the prototype, "glass on" means `backdrop-filter` on the top bar's pills, the room labels, the selected colleague's card and the variant bar. In the app (spec 17 on `spec/office-v1`) it would be the top bar and the room labels, plus the drawer's composer and dock while the drawer is open. `glass=0` turns all of it off.
- **Glass on the top bar only (measured, `glass=top`).** The GPU process read 11.6, against 7.7 with no glass and 21.8 with all of it. So the top bar's glass costs about 4 points, a quarter of all the glass. This contradicts what the source suggests and what spec 17 on `spec/office-v1` says ("keeping glass on only part of the Office then likely keeps most of the cost"). Both readings fit the data:
  - The GPU process's wakeups fell to about 290 with any glass (all of it, or the top bar only), against about 390 with none. So one `backdrop-filter` does change how the window is composited, as the source says.
  - But the CPU cost grows with how much is blurred. The room labels are about 20 blurred areas over the moving picture; the top bar is 4 pills over the empty floor.
  - The screenshots cannot show the top bar's blur: the pills sit over the empty floor, where a blur changes no pixel (the `glass=top` and `glass=0` screenshots are identical). The wakeup change is the evidence that the filter was on.
  - This is one session, two runs each, with the camera at rest. The top bar would also sit over a moving picture while the camera moves.
- **Spec 17's Baseline** said "Glass costs almost nothing on this machine". That was measured over a page that changes little. It does not hold over a canvas that draws every frame. The spec on `spec/office-v1` is already amended.

### Ambient occlusion (GTAO)

- **What it is.** The prototype's High quality runs three.js's `GTAOPass` in an `EffectComposer`. `GTAOPass` draws the whole scene a second time with `MeshNormalMaterial`, which repeats the matrix updates, the bone uploads and, with live shadows, the shadow maps. Then it adds 4 full-screen passes. The prototype's frame at High is: 2 scene renders, 2 shadow renders, an MSAA resolve and 5 full-screen passes.
- **What it saves.** Draw calls halve, 1803 → 900. Measured in one session, both at High without glass: renderer 16.6 → 9.2, GPU process 15.2 → 7.6, GPU time 8.4 → 4.9 ms, JavaScript 3.7 → 1.9 ms a frame. It is the largest saving after the cap and the glass.
- **What it costs.** Contact darkness under desks and in corners. Static shadows carry most of the depth. If AO comes back, it comes back through the building cache, drawn once when the camera rests.

### Shadows drawn once

- **What it is.** `renderer.shadowMap.autoUpdate = false`, and `shadowMap.needsUpdate = true` whenever the building, the sun or the theme changes. Characters stop casting into the sun's map.
- **What it saves.** The shadow pass each frame: draw calls 1803 → 1149, renderer about -1.5, GPU process about -1.3. Measured.
- **What it costs.** No moving shadows under colleagues. A blob shadow, one soft dark disc per colleague in one instanced draw, brings back the contact. Estimated under 0.1 ms.
- **Detail.** three.js r186 also has a per-light `LightShadow.autoUpdate`. The map is cleared and redrawn whole each time, so there is no partial update.

### The building cached into colour and depth

- **What it is.** The building does not move between happenings, so it is drawn once into an off-screen colour texture and a depth texture. Each frame then:
  1. copies the colour texture to the canvas with one full-screen quad, which also writes the stored depth through `gl_FragDepth`;
  2. draws the colleagues over it, depth-tested against the stored depth, so a desk still hides the legs behind it.

  This is the old trick of pre-rendered backgrounds. Pillars of Eternity renders its backgrounds with a depth pass "for per-pixel occlusion of 3D objects". ScummVM's Grim Fandango engine writes the background's Z bitmap into the depth buffer before it draws the characters.
- **How the spike does it.**
  - Every object of the building goes on layer 1; colleagues stay on layer 0. Lights are on every layer.
  - The building is drawn again into the cache when the camera's matrices change, when the canvas is resized, and when the theme, the time of day, the lamps, the quality or the fonts change.
  - Ambient occlusion is added to the cache only once the camera rests, one frame later.
  - The cache target uses 4x MSAA, so edges stay smooth.
  - The copy quad does the tone mapping and colour-space step that the composer's `OutputPass` did.
- **Why not a blit.** WebGL fixes no depth format for the canvas. Chromium gives it `DEPTH24_STENCIL8`, and blitting into a multisampled canvas is an error in OpenGL ES 3.0. A quad that writes `gl_FragDepth` works everywhere; only that one quad loses early depth testing.
- **What it saves (measured).** At High's look: renderer 14 → 7, GPU process 12 → 5.5, draw calls 1803 → 51, GPU time 8.3 → 0.6 ms. It is the cheapest way found to keep AO and pixel ratio 2.
- **What it costs (measured and seen in screenshots):**
  - **The overview looks the same.** A screenshot diff against the live High render: mean difference 0.23 of 255, 0.12% of pixels differ visibly.
  - **Close up, the colleagues look flatter.** With a colleague selected and the camera close: mean difference 5.5, 6.2% of pixels. The colleague has no sun shadow on the floor and no AO, because both are part of the cached building only. A blob shadow covers most of it.
  - **While the camera moves, the cache is drawn every frame.** Then a frame costs the whole building, plus the copy, plus the colleagues: slightly more than no cache. Following a walking colleague moves the camera every frame: the spike measured 30 cache redraws a second while following one, so the cache saves nothing then.
  - **Memory:** one 4x MSAA half-float colour target with depth, plus the AO targets, at canvas size. The working set read 725 MB with the cache, against 729 MB without. The composer's targets it replaces are of the same size.
  - **Every change must invalidate the cache.** A missed one shows a stale building. The spike needed six kinds of invalidation. v1 would add the event-flow capsules, the doors, and anything else in the building that moves.
- **How it combines:**
  - With merging: merging makes each cache redraw cheaper, which is exactly the cost the cache leaves (the camera moving).
  - With static shadows: implied. The cached building's shadows are drawn only when the cache is.
  - With the 30 fps cap: the cache makes each frame cheap; the cap makes frames rare.
  - With glass: glass still costs its 19 points in the GPU process on top.

### Merging, instancing and `BatchedMesh`

- **Merging** (measured) bakes each static mesh's position into its geometry and joins meshes that share a material into one. At Today's fleet it saves little on its own (renderer 14 → 12), because draw calls are cheap on this machine. At Ten times the renderer's JavaScript is the cost, and merging with static shadows takes the renderer from 25 to 15 and draw calls from 2620 to 598.
- **Costs.** It needs compatible attributes. Merged meshes are larger, so frustum culling skips less in a close-up. Merging per room and per material keeps culling useful. Walls that drop away to the dado rail cannot be merged with the rest of their room.
- **Instancing** fits props that repeat: desks, chairs, typewriters, lamps, plants. One draw per kind of prop part. It uses less memory than merging, because the geometry is stored once.
- **`BatchedMesh`** draws many different geometries with one material in one draw call through `WEBGL_multi_draw`, and keeps per-object visibility and culling. It fits a building whose walls must still drop away one by one. Estimated: merging's draw count, with less memory and the cutaway walls kept.
- **`matrixAutoUpdate`.** The scene root flags itself every frame, which forces a world-matrix multiply on every object, static or not. Setting `matrixAutoUpdate = false` on the scene and on static groups, and updating the colleagues directly, saves that walk. Estimated: a fraction of a millisecond at Today's fleet, more at Ten times. After merging the object count drops, and it matters less.
- **Frustum culling** is on by default and already skips what is off screen. A skinned mesh's bounding sphere is computed once from its current pose; recomputing it skins every vertex on the CPU, so leave it as it is.

### Pixel ratio and `powerPreference`

- **Pixel ratio 1** at High: GPU time per frame 8.3 → 6.0 ms. CPU unchanged. On this GPU, pixels are not the bottleneck. On a MacBook Air they will matter more (estimated). three.js's own manual advises rendering heavy scenes at a lower ratio and letting the browser scale up, and capping the drawing buffer's size.
- **Pixel ratio 1.5 vs 2** was measured only together with Medium's other changes.
- **`powerPreference: "low-power"`** changed nothing. Apple silicon has one GPU, and Chromium gives every preference the same GPU when there is only one. On a dual-GPU Intel Mac, `"high-performance"` picks the discrete GPU, so `"low-power"` (or `"default"`) is still the right value to ship.

### Sim and skeletons at 15 Hz

- **What it is.** The sim, the animation mixer and the bone matrices move 15 times a second, while frames still draw at 30.
- **Measured:** no saving at Today's fleet (Medium 9.9 / 7.9, with 15 Hz 8.7 / 7.3, within the spread), and none at Ten times (14.6 / 10.3 against 14.6 / 11.0).
- **Why so little.** three.js calls `skeleton.update()` once per `render()` for every skinned mesh that passes culling, and that marks the bone texture for upload. So skipping the sim saves only the sim's JavaScript, not the bone uploads.
- **Better, for later.** Skip the sim and animation of colleagues that are off screen or too far to see, as Unity's `CullCompletely` and Unreal's animation budget do. three.js never does this on its own.

### Instanced skinned characters (estimated)

- **What it is.** Every colleague of one style is drawn in one draw call per mesh part, instead of one per colleague. A vertex shader reads each instance's bone matrices from one shared data texture.
- **What it saves.** Each colleague is 2-3 skinned meshes, so 16 colleagues are about 40 draws and 40 bone-texture uploads a frame. At Ten times it is about 400 of each. Instanced, either fleet is 2-3 draws and one upload. At Today's fleet the gain is small, because the building, not the colleagues, holds the draws (the cache, which draws only the colleagues, uses 51 draws).
- **What it costs.** three.js r186 has no instanced skinning: `InstancedMesh` and `BatchedMesh` have no skinning code. Two routes:
  - `@three.ez/instanced-mesh` (0.3.16, peer `three >= 0.159`) has `initSkeleton` and `setBonesAt` with one bone texture for all instances, per-instance culling and LOD. A new dependency.
  - Own shader chunks over three.js's bone texture (GPU Gems 3, chapter 2). A few hundred lines and a custom material.
  - Either way, picking, hover and selection highlights must work per instance.
- **A cheap first step.** `SkeletonUtils.clone` gives each skinned mesh its own skeleton, so a colleague made of three meshes uploads three bone textures a frame. Sharing one skeleton across a colleague's meshes cuts that to one.

### Impostors and levels of detail (estimated)

- **Impostors.** A far colleague is drawn as a small picture on a card that faces the camera, taken from an atlas drawn once per pose. It is accurate for one viewing direction only. At Ten times in the overview, every colleague is already a few pixels tall.
- **Levels of detail.** three.js `LOD` switches whole objects by distance. The building holds most triangles: Today's office is 1.89 M triangles, of which the colleagues are about 77 k. Plants, chairs and typewriters are the obvious candidates for a cheaper far version.
- **What it saves.** GPU vertex work, which matters on a small GPU more than on an M4 Max. Little CPU, because the draw count stays the same unless far props are merged too.
- **For later.** Neither is needed for Today's fleet.

### Baked light, shadows and ambient occlusion (estimated)

- **What it is.** Light, shadow and AO for the building are worked out once and stored in textures (light maps) or in vertex colours, so the shaders read them instead of computing them.
- **What three.js offers.** `lightMap` and `aoMap` read any UV set through `texture.channel`. `aoMap` darkens only indirect light, not the sun. `ProgressiveLightMap` builds light and shadow over many frames in the browser, but needs a clean, non-overlapping UV unwrap of every piece. Vertex colours need no UVs, but carry only as much detail as there are vertices.
- **Why it is later.** The building is built in code from a kit, and it changes: themes repaint it, lamps switch on, walls drop away, and fleets add rooms. Each change would need a new bake. The building cache gets the same result at run time and needs no unwrap.

### Partial redraws (estimated, not recommended)

- Drawing only the parts of the canvas where a colleague moved needs `preserveDrawingBuffer: true` or an off-screen target, and Chromium marks the whole canvas as changed on any WebGL draw. It could save GPU drawing, but no compositing. Not worth it.

## The Electron and Chromium side

### When the window is not looked at

- **`backgroundThrottling`** is on by default, and the app does not change it (`apps/desktop/src/main/window.ts`). Keep it on. It turns hidden, minimized and covered into `visibilityState: "hidden"`, stops rAF, and limits timers to one wake a second (one a minute after 5 minutes hidden). Every trigger is visibility; nothing reads focus.
- **A covered window stops drawing.** Chromium's `WebContentsOcclusionCheckerMac` is always on in Chromium 152. It trusts macOS's `NSWindow.occlusionState`, and groups changes over about one second. Measured with a cover window of the same app: `hidden`, 0.1% renderer, 0% GPU process. A window of another app should behave the same, because macOS reports occlusion per window, but that was not tested. Electron 44 patches the checker to ignore transparent or click-through windows.
- **Minimized was not measured.** In a terminal-launched Electron, `BrowserWindow.minimize()` did nothing (`isMinimized()` stayed false). By Chromium's source, minimized is hidden. Check it once in the packaged app.
- **Focus does nothing on its own.** A visible window that lost focus keeps `visibilityState: "visible"` and full-rate rAF: measured at 30 fps and the same cost as focused. That matches the decision that an unfocused window keeps 30 fps, so v1 needs no focus code. If it ever wants some, the renderer has `window` `blur` and `focus` events and `document.hasFocus()`; main has `BrowserWindow` `blur`, `focus` and `isFocused()`.

### On battery

- **`navigator.getBattery()` works in the renderer.** Measured in Electron 44.4.5 in a secure context: it returned `charging: true, level: 0.8`, which matches `pmset -g batt` ("80%; AC attached; not charging"). The app's own scheme is registered `secure: true` (`apps/desktop/src/main/index.ts`), so the app's page qualifies. No new IPC channel is needed.
- **`charging` is `true` whenever the Mac is on AC,** even while macOS holds the charge at 80%. So `charging === false` means "on battery".
- **Listen for `chargingchange`.** Unplugging was not tested, because the machine stayed on AC.
- **The fallback,** if `getBattery` ever fails: `powerMonitor` in main (`on-battery`, `on-ac`, `isOnBatteryPower()`), plus one IPC event to the renderer.
- **macOS Low Power Mode** has no Electron API. macOS has `ProcessInfo.isLowPowerModeEnabled`; Electron 44 does not expose it. Treat battery as the signal.
- **Thermal pressure:** `powerMonitor` has `thermal-state-change` and `speed-limit-change`, in main only. Not needed for v1.

### rAF or a timer at 30 fps

Three loops were measured, each drawing at most 30 frames a second:

- **rAF that skips frames:** the loop runs on every rAF, and draws only when 29 ms or more passed since the last draw.
- **Timer:** `setTimeout` for the time until the next frame is due, then draw in the timeout.
- **Timer, then rAF:** `setTimeout` as above, then ask for one rAF to draw in.

All three read the same, within the spread: renderer 14-16%, GPU process 29-31%, renderer 59-65 wakeups a second, GPU process about 315. So keep rAF, because it stops by itself in a hidden window.

What Chromium does underneath (from its source):

- On a 120 Hz display, a rAF loop wakes the renderer's main thread, its compositor thread and the GPU process's display compositor 120 times a second. On a skipped frame the commit stops early and nothing is drawn.
- Chromium never asks a ProMotion display for a lower refresh rate for canvas content, and Electron has no switch that caps the frame rate. Chrome's own battery saver throttles every frame sink to 30 Hz through `content::StartThrottlingAllFrameSinks`; Electron does not call it.
- The display link stops only after 20 vsyncs with nobody asking for frames, about 167 ms at 120 Hz. A 33 ms timer loop never lets it stop. That is why the timer saved nothing.
- The display link stops entirely only when nothing in the window asks for frames: no rAF, no timer that draws, and no CSS animation or blinking caret anywhere in the window.

## How to measure it, the same way every time

The harness is `apps/desktop/scripts/office-power.mjs` on the spike branch. It is about 250 lines, and needs nothing beyond the repository's Electron and a Vite dev server for the prototype.

```
env -u ELECTRON_RUN_AS_NODE apps/desktop/node_modules/.bin/electron \
  apps/desktop/scripts/office-power.mjs \
  --url 'http://127.0.0.1:5318/specimens/office-prototype/index.html?flow=0&gputime=1&cap=raf' \
  --label cap --settle 14 --sample 10 [--mode visible|hidden|covered|blurred] [--pan] [--shot out.png]
```

What it does:

1. It opens one 1440 x 900 window on the built-in display, with a scratch user-data folder that it deletes on quit. No Playwright or DevTools is attached, because an attached tool changes the readings (spec 17 §Measuring).
2. It waits for the page to settle, then reads everything below over the same 10-second window.
3. It prints one JSON line per run. A shell loop runs every configuration in turn, twice, interleaved, so slow drift on the machine hits every configuration alike.

What it reads, and from where:

| Reading | Source | Notes |
|---|---|---|
| CPU per process, in % of one core | `app.getAppMetrics()`: the growth of `cpu.cumulativeCPUUsage` over the sample, divided by its length | Do not use `cpu.percentCPUUsage`. Electron divides it by the number of logical CPUs, so on this 16-CPU Mac it reads a sixteenth of the share of one core. `ps` CPU time agreed with `cumulativeCPUUsage` within a point |
| Wakeups per process | `app.getAppMetrics()`: `cpu.idleWakeupsPerSecond` | The kernel's interrupt wakeups, the number Activity Monitor shows. It does not count package idle exits, which matter more for energy |
| Energy impact per process | `top -l 2 -s 10 -pid ... -stats pid,cpu,idlew,power`, the second sample | Apple's relative "Energy Impact". It followed the CPU share closely in every run, so it adds little |
| Frames a second, JavaScript time per frame, draw calls, triangles | Counters in the page | JavaScript time is split into the frame listeners (sim, camera, tags) and `render` |
| GPU time per frame | `EXT_disjoint_timer_query_webgl2`: a `TIME_ELAPSED` query around each frame's render | Only comparable between runs at the same frame rate |
| Memory | `app.getAppMetrics()`: summed `memory.workingSetSize` | The working set, not the physical footprint that spec 17's budget limits |

Two readings were tried and dropped:

- **`ioreg -c IOAccelerator`, "Device Utilization %"** reads the whole GPU, for every app, and rises as the GPU clocks down. A page drawing 0.5 ms of GPU work a frame read 72-79%. A blank window read 15%. It does not measure energy.
- **`percentCPUUsage`,** as above.

What it does not read, and how to get it:

- **GPU power in milliwatts.** `sudo powermetrics --samplers gpu_power,tasks --show-process-energy -i 1000 -n 10` gives the GPU's power and each process's energy estimate. It needs `sudo`, which the measuring session did not have. Run it beside the harness for the two or three configurations that matter, and subtract a blank window.
- **Battery drain.** Run on battery for a fixed time and read `pmset -g batt` before and after. Only worth doing once v1 is built.

Rules that keep runs comparable:

- Note the load average (`uptime`), the power source (`pmset -g batt`) and the display's refresh rate. This machine's built-in display runs at 120 Hz. Low Power Mode and many external displays run at 60, which halves how often a rAF loop wakes.
- Run a blank window in the same harness, as the floor.
- Compare GPU time per frame only at equal frame rates.
- Repeat each configuration at least twice, interleaved, and report the spread.
- Do not edit the page's source while a run is going: Vite reloads the page.

### How to record it in spec 17 §Measured

One table per Office measurement:

| Measure | Value |
|---|---|
| Machine, macOS, Electron | ... |
| Display, refresh rate, power source, load average | ... |
| Window and canvas size | 1440 x 900, canvas ... |
| Fleet, map, liveliness, quality | ... |
| Frames a second | ... |
| Renderer: % of one core, wakeups a second | ... |
| GPU process: % of one core, wakeups a second | ... |
| GPU time per frame | ... |
| Draw calls, triangles | ... |
| Hidden, covered, standing still: renderer and GPU process % of one core | ... |

## Surprises, and where this contradicts the spec or the ticket

- **`percentCPUUsage` is not a share of one core.** Electron divides it by the number of logical CPUs. `apps/desktop/scripts/perf.ts` records it as `cpuPercent`, so its CPU numbers read a sixteenth of the share of one core on this Mac. Spec 17's "the spinner, 0.8% of a core in the GPU process" probably came from it (about 13% of one core, if so); [#339](https://github.com/theagenticage/hercule/issues/339), the Office's measuring script, takes it up. Before `perf.ts` checks the Office's CPU limits, it should use `cumulativeCPUUsage`, as spec 17 on `spec/office-v1` now says.
- **Glass over a live canvas is expensive.** 14-19 points of one core in the GPU process at 30 fps with the camera at rest, and about 43 in all while the camera moves. Spec 17's Baseline said glass costs almost nothing; that holds only over a still page. Already amended on `spec/office-v1`.
- **Glass on the top bar only costs about a quarter of all the glass** (about 4 points of the GPU process), not most of it as Chromium's source suggests and spec 17 on `spec/office-v1` says. Its wakeups match all-glass, so the compositing does change; the cost follows the blurred area. This matters for [#341](https://github.com/theagenticage/hercule/issues/341).
- **The cost of ambient occlusion moved between sessions.** High against Medium, without glass, read about 4 points apart in each process in the first session, and about 8 in the 21:58 session. Both ran twice, interleaved. The cause of the gap is unknown, so take AO's cost as 4-8 points in each process.
- **A 30 fps Office cannot meet the idle budget.** It wakes the renderer about 65 times a second and the GPU process 300-430 times, whatever a frame costs. Only standing still meets it. Spec 17 on `spec/office-v1` now gives the Office its own budget row.
- **The GPU process costs more than the renderer** in most rows. A budget on the renderer alone would miss the larger half.
- **A timer loop saves nothing** against a rAF loop that skips frames. The display link keeps running either way.
- **A blurred window is not throttled.** That matches the ticket's decision (an unfocused window keeps 30 fps), so nothing needs to be built.
- **Battery needs no IPC.** The Electron docs suggest `powerMonitor`, which lives in main, but `navigator.getBattery()` works in the renderer.
- **Following a walking colleague defeats the building cache,** because the camera moves every frame.
- **`powerPreference` and 15 Hz sim** do nothing measurable on this machine.

## What was measured and what was estimated

- **Measured,** on the machine above, two interleaved rounds per row: the first Today table, and the 21:58 session of the later-sessions table. Also measured: the loop comparison, `getBattery()`, and the screenshot diffs of the building cache.
- **Measured once:** the Ten times table, the camera-moving table, the window states, and the rows marked "once" in the later-sessions table.
- **From source, not measured:** why glass costs what it does (delegated compositing), the display link's 20-vsync keep-alive, minimized being treated as hidden, the occlusion checker's details, three.js's bone uploads per `render()`.
- **Estimated:** instanced skinning, impostors and LOD, baked light, `BatchedMesh`, `matrixAutoUpdate`, blob shadows, partial redraws, and every number for a Mac other than this one.
- **Not measured:** GPU power in milliwatts (needs `sudo powermetrics`), battery drain, minimized windows, a window covered by another app, unplugging the power.

## The spike

Branch `spike/office-rendering`, local only, on top of `prototype/office-3d` (6fcb3634). It adds URL switches to the prototype, and the harness, in two commits:

- `42db434c`: the switches and the harness;
- `ff149158`: the `ao=off` and `glass=top` switches, and a harness that also reads a blank page.

Switches, read from the page's URL in `engine/stage.ts`:

| Switch | What it does |
|---|---|
| `cap=raf\|timer\|timerraf`, `fps=` | Caps the frame rate with one of the three loops (default 30) |
| `glass=0` | Sets `--glass-filter: none` on the root element, so every `backdrop-filter` in the page reads `none`: the top bar's pills, the card, the room labels and the variant bar. The fills and `--glass-level` stay. This is the path the app takes at glass level 0 (`base.css`) |
| `glass=top` | Glass on the top bar's pills only, `none` everywhere else |
| `quality=medium` | The prototype's Medium: pixel ratio 1.5, 2048 shadow map, no AO |
| `ao=off` | No ambient occlusion, at any quality |
| `pr=` | Sets the pixel ratio |
| `shadows=static` | Draws the sun's shadows once, again only when the building changes; colleagues cast none |
| `merge=1` | Merges the building's static meshes by material (`office-scene.ts`, `mergeStatic`) |
| `cache=1` | Draws the building into a colour and depth cache and the colleagues over it (`drawCached`) |
| `animhz=15` | Moves the sim and animation 15 times a second |
| `lowpower=1` | `powerPreference: "low-power"` |
| `gputime=1` | Times each frame's GPU work with `EXT_disjoint_timer_query_webgl2` |

The harness, `apps/desktop/scripts/office-power.mjs`, is described under "How to measure it". The page exposes its counters (frames, JavaScript time, GPU time, cache redraws, skipped rAFs, draw calls) on `window.office.stage.spike`.

Known shortcuts in the spike:

- `mergeStatic` removes the merged meshes from the scene but does not dispose of their geometry, so the measured memory rise is too high.
- The cache invalidates on every camera change, even one that does not change the picture.
- Minimize does not work from the harness.

## Sources

Electron and Chromium (Electron 44.4.5, Chromium 152, branch 7977):

- `BrowserWindow` page visibility: https://www.electronjs.org/docs/latest/api/browser-window#page-visibility
- `webPreferences.backgroundThrottling`: https://www.electronjs.org/docs/latest/api/structures/web-preferences
- `powerMonitor`: https://www.electronjs.org/docs/latest/api/power-monitor
- `percentCPUUsage` divided by the CPU count: https://github.com/electron/electron/blob/v44.4.5/shell/browser/api/electron_api_app.cc#L1435-L1465
- Electron's occlusion patch and its issues: https://github.com/electron/electron/issues/51718, https://github.com/electron/electron/issues/43058
- Chromium source (occlusion checker, display link, delegated compositing, frame-rate throttling): https://chromium.googlesource.com/chromium/src/+/refs/branch-heads/7977/ (`content/app_shim_remote_cocoa/web_contents_occlusion_checker_mac.mm`, `ui/display/mac/cv_display_link_mac.mm`, `components/viz/service/frame_sinks/external_begin_frame_source_mac.h`, `components/viz/service/display/ca_layer_overlay.cc`, `content/public/browser/frame_rate_throttling.h`)
- Timer throttling in hidden pages: https://developer.chrome.com/blog/timer-throttling-in-chrome-88
- WebGL context attributes and drawing buffer: https://registry.khronos.org/webgl/specs/latest/1.0/#WEBGLCONTEXTATTRIBUTES, https://registry.khronos.org/webgl/specs/latest/1.0/#THE_DRAWING_BUFFER
- OpenGL ES 3.0 blit rules: https://registry.khronos.org/OpenGL/specs/es/3.0/es_spec_3.0.pdf#page=209
- Timer query on ANGLE Metal: https://chromium.googlesource.com/angle/angle/+/refs/heads/chromium/7977/src/libANGLE/renderer/metal/QueryMtl.mm#104

Apple:

- Low Power Mode: https://developer.apple.com/documentation/foundation/processinfo/islowpowermodeenabled
- One GPU on Apple silicon: https://developer.apple.com/documentation/metal/mtldevice/islowpower
- Energy Impact: https://support.apple.com/guide/activity-monitor/view-energy-consumption-actmntr43697/mac
- Energy efficiency guide: https://developer.apple.com/library/archive/documentation/Performance/Conceptual/power_efficiency_guidelines_osx/

three.js r186 (https://github.com/mrdoob/three.js/blob/r186/):

- `src/renderers/webgl/WebGLShadowMap.js`, `src/lights/LightShadow.js` (shadow updates)
- `src/core/Object3D.js`, `src/renderers/WebGLRenderer.js` (matrix updates, `copyTextureToTexture`)
- `src/renderers/webgl/WebGLObjects.js` (bone uploads per `render()`)
- `examples/jsm/postprocessing/GTAOPass.js` (the second scene render)
- `examples/jsm/utils/SkeletonUtils.js` (one skeleton per cloned mesh)
- `examples/jsm/misc/ProgressiveLightMap.js` (baked light)
- Manual, responsive and pixel ratio: https://threejs.org/manual/#en/responsive
- Manual, rendering on demand: https://threejs.org/manual/#en/rendering-on-demand

Game development:

- Pillars of Eternity's pre-rendered backgrounds: https://eternity.obsidian.net/news/update--79-graphics-and-rendering-
- ScummVM's Grim Fandango depth bitmap: https://github.com/scummvm/scummvm/blob/238d37cdc9e2817fe27964ebca752fe96fdef1da/engines/grim/gfx_opengl.cpp#L1657-L1680
- GPU Gems 3, animated crowd rendering: https://developer.nvidia.com/gpugems/gpugems3/part-i-geometry/chapter-2-animated-crowd-rendering
- GPU Gems 3, true impostors: https://developer.nvidia.com/gpugems/gpugems3/part-iv-image-effects/chapter-21-true-impostors
- `@three.ez/instanced-mesh`: https://github.com/agargaro/instanced-mesh
- Unreal's animation budget: https://dev.epicgames.com/documentation/en-us/unreal-engine/animation-budget-allocator-in-unreal-engine
- Unity's `AnimatorCullingMode`: https://docs.unity3d.com/ScriptReference/AnimatorCullingMode.html
- Fix your timestep: https://gafferongames.com/post/fix_your_timestep/
