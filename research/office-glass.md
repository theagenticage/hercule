# Research: frosted glass over the Office at close to no cost

Ticket: [#341](https://github.com/theagenticage/hercule/issues/341). Spike: branch `spike/office-glass`.

Sources are pinned: Chromium `152.0.7977.130` (the Chromium of Electron 44.4.5, which the app ships), Electron `v44.4.5`, T3 Code at `cfdff56f`, VS Code at `810f8088`.

## The short answer

- **Why one blur costs the whole window.** On macOS, Chromium normally draws nothing itself: it hands the canvas and each HTML layer to macOS as separate layers, and macOS puts them on screen. A `backdrop-filter` needs the pixels under it, and macOS will not give Chromium those pixels. So Chromium has to draw everything under the blur itself. Chromium's code makes this all or nothing: if one layer cannot be handed over, none is. Then Chromium draws the whole window into one image, on every frame the Office draws.
- **T3 Code** uses CSS `backdrop-filter` and no vibrancy. Its chat composer is blurred over the scrolling, streaming transcript. One of its own unmerged PRs says large surfaces get no blur "because one blurred layer that big repaints on every streaming frame".
- **Vibrancy cannot help.** Electron's `vibrancy` blurs only what is behind the window (the desktop), and it sits under all web content.
- **Glass the Office draws itself works, and is cheap.** The Office already draws its frame in WebGL. It can shrink that frame, blur it, and paint it under its own panels. No element of the page then has a `backdrop-filter`, so macOS keeps doing the compositing. Numbers: see [Measured](#measured).
- **#301's choice does not change.** This trick needs a canvas under the glass. The thread screens have HTML under their glass, so they still choose between a live blur and solid surfaces.

## 1. Why one `backdrop-filter` costs the whole window

### In plain words, one frame at a time

The window is 1440 x 900 points, so 2880 x 1800 pixels on a Retina screen. The Office's canvas fills most of it: 2336 x 1744 pixels. Over the canvas sit HTML layers: the top bar's pills, the room labels, the name tags, the card.

**One frame with no blur anywhere:**

1. three.js draws the Office into the canvas's buffer. This is the same in both cases.
2. Chromium's compositor (viz, in the GPU process) gets a list of rectangles ("quads"): one for the canvas, one per HTML layer. It turns each into a macOS layer (a `CALayer`). The canvas's layer simply points at the buffer three.js just drew into. Nothing is copied.
3. Chromium marks its own drawing as "nothing to do" and draws no pixel.
4. macOS's window server stacks the layers on screen, as it does for every app.

**The same frame with one blurred element, even an 8 x 8 pixel dot:**

1. three.js draws the Office into the canvas's buffer, as before.
2. Viz tries to turn each quad into a `CALayer`. The blurred element's quad cannot be one. Viz throws the whole list away.
3. Viz now draws the window itself, with Skia, into one window-sized image:
   - it copies the canvas's 2336 x 1744 pixels into that image;
   - it draws every HTML layer that overlaps the changed area, which is the whole canvas, so all of them;
   - for each blurred element, it reads back the pixels it has just drawn under that element, blurs them, and draws the element on top.
4. Viz hands that one image to macOS, which puts it on screen.

At 30 frames a second, step 3 is the 19 points of one core that the GPU process spends in #333's measurement (31% with glass, 12% without).

### Why Chromium cannot just blur the small area

- A `backdrop-filter` is drawn by Skia's `saveLayer` with a backdrop filter. That call reads the pixels already drawn into the same image. So the pixels under the blur must be drawn by Chromium, in the same image.
- Pixels that macOS composited from `CALayer`s are not available to Chromium. Core Animation has a layer that blurs what is under it (`CABackdropLayer`), but it is private API. Safari (WebKit) uses it. Chromium does not.
- Chromium could, in principle, draw only the part of the window under the blur and still hand the rest to macOS. Its code does not do that. It tries to turn every quad into a `CALayer`, and at the first one it cannot, it gives up on all of them. Only protected video keeps a layer of its own.

### What Chromium's source says

All links are to Chromium `152.0.7977.130`.

1. Blink gives an element with `backdrop-filter` a render surface of its own (reason `kBackdropFilter`), and its parent effect one too (reason `kBackdropScope`). [`property_tree_manager.cc` L1054](https://github.com/chromium/chromium/blob/152.0.7977.130/third_party/blink/renderer/platform/graphics/compositing/property_tree_manager.cc#L1054), [L1335](https://github.com/chromium/chromium/blob/152.0.7977.130/third_party/blink/renderer/platform/graphics/compositing/property_tree_manager.cc#L1335). That surface reaches viz as a render pass quad with backdrop filters.
2. A render pass quad with backdrop filters cannot become a `CALayer`:
   ```cc
   if (!quad->backdrop_filters.IsEmpty()) {
     return gfx::kCALayerFailedRenderPassBackdropFilters;
   }
   ```
   [`ca_layer_overlay.cc` L85-87](https://github.com/chromium/chromium/blob/152.0.7977.130/components/viz/service/display/ca_layer_overlay.cc#L85-L87). An ordinary `filter`, `blur()` included, is allowed ([L63-79](https://github.com/chromium/chromium/blob/152.0.7977.130/components/viz/service/display/ca_layer_overlay.cc#L63-L79)). Only the backdrop kind fails.
3. The loop over the quads stops at the first failure, and then the whole list is cleared:
   ```cc
   if (result != gfx::kCALayerSuccess) {
     ca_layer_overlays->clear();
     return false;
   }
   ```
   [`ca_layer_overlay.cc` L419-449 and L462-465](https://github.com/chromium/chromium/blob/152.0.7977.130/components/viz/service/display/ca_layer_overlay.cc#L419-L465).
4. On success, viz sets the damage to empty, so it draws nothing itself. On failure, it adds a "primary plane": one window-sized image that viz draws. [`overlay_processor_mac.cc` L57-80](https://github.com/chromium/chromium/blob/152.0.7977.130/components/viz/service/display/overlay_processor_mac.cc#L57-L80).
5. The root render pass is skipped only when its damage is empty; otherwise it is drawn. [`direct_renderer.cc` L430-449](https://github.com/chromium/chromium/blob/152.0.7977.130/components/viz/service/display/direct_renderer.cc#L430-L449). Damage that touches a blurred backdrop is widened to the whole blurred element. [`direct_renderer.cc` L994-1031](https://github.com/chromium/chromium/blob/152.0.7977.130/components/viz/service/display/direct_renderer.cc#L994-L1031).
6. The blur itself is a Skia `saveLayer` with a backdrop filter, which reads what is already drawn. [`skia_renderer.cc` L1785-1787](https://github.com/chromium/chromium/blob/152.0.7977.130/components/viz/service/display/skia_renderer.cc#L1785-L1787).
7. The reason codes are in [`ca_layer_result.h`](https://github.com/chromium/chromium/blob/152.0.7977.130/ui/gfx/ca_layer_result.h#L17-L55): `kCALayerFailedRenderPassBackdropFilters = 19`. A trace or the `Compositing.Renderer.CALayerResult` histogram shows which one a page hits.

Chromium knows. [Issue 558556742](https://issues.chromium.org/issues/558556742) (assigned, opened 2026-09-08) says backdrop-filter is on 35% of page loads and one such quad "forces the entire frame to be composited by Chrome". A prototype fix, [CL 8369961](https://chromium-review.googlesource.com/c/chromium/src/+/8369961), uses the private `CABackdropLayer`. It is open and not merged. No switch or feature in Chromium 152 hands a backdrop filter to Core Animation.

### What else turns the hand-off off

From the same function. Any one of these, anywhere in the window, has the same effect as a blur:

- a blend mode other than normal (`mix-blend-mode`);
- corners that are not all the same radius;
- a `filter` other than grayscale, sepia, saturate, hue-rotate, invert, brightness, contrast, opacity, blur and drop-shadow;
- `transform-style: preserve-3d`;
- a mask or clip under a rotated or skewed transform;
- more than 30 layers that need a render pass;
- more than 128 quads in all (`kCALayerNewLimit`, which raises it to 1024, is off by default: [`features.cc` L171](https://github.com/chromium/chromium/blob/152.0.7977.130/components/viz/common/features.cc#L171));
- a screen recording or a copy request.

**Side finding, from the source only, not measured.** Every name tag has `will-change: transform, opacity`, so each tag is a layer and a quad. With the "Ten times" fleet of 142 colleagues, the tags alone could pass 128 quads, and the hand-off would fail with no glass at all (`kCALayerFailedTooManyQuads`). Worth checking with a trace when v1 is measured at that size.

## 2. What other apps do

**T3 Code** (Electron, `cfdff56f`):

- **CSS `backdrop-filter`, no vibrancy.** Five glass classes in [`index.css` L325-408](https://github.com/pingdotgg/t3code/blob/cfdff56f7b3c9c931ae368224041aa14825649fd/apps/web/src/index.css#L325-L408) (`surface-glass`, `alert-glass`, `dialog-glass`, `dialog-backdrop`, `dropdown-glass`), blur 12 px light and 16 px dark. About 15 more places use Tailwind's `backdrop-blur-*`.
- The main window sets an opaque `backgroundColor` and no `vibrancy`, `transparent` or `visualEffectState`: [`DesktopWindow.ts` L397-421](https://github.com/pingdotgg/t3code/blob/cfdff56f7b3c9c931ae368224041aa14825649fd/apps/desktop/src/window/DesktopWindow.ts#L397-L421).
- **Glass over moving content: yes.** The chat composer's `::before` layer is blurred ([`ComposerSurface.tsx` L22-23](https://github.com/pingdotgg/t3code/blob/cfdff56f7b3c9c931ae368224041aa14825649fd/apps/web/src/components/chat/ComposerSurface.tsx#L22-L23)) and sits over the transcript, which scrolls and streams. So T3 Code pays the cost described above while a turn streams. Sticky headers over scrolling tables are blurred too. Menus, dialogs and toasts are blurred but short-lived.
- **What they learned:**
  - Merged [PR #4446](https://github.com/pingdotgg/t3code/pull/4446) removed the blur from sidebar rows, because many small blurred layers were recomposited when hover controls appeared.
  - Closed, unmerged [PR #12897](https://github.com/pingdotgg/t3code/pull/12897): "Large surfaces get no backdrop-filter, because one blurred layer that big repaints on every streaming frame. The scenes are softly defocused in the image itself instead." That is a pre-blurred image.
  - The fade under the title bar is a `mask-image` gradient, not a blur ([`index.css` L410-446](https://github.com/pingdotgg/t3code/blob/cfdff56f7b3c9c931ae368224041aa14825649fd/apps/web/src/index.css#L410-L446)).
  - No issue or commit measures the composer blur's GPU or power cost.

**VS Code** (`810f8088`):

- Frosted glass arrived only on 2026-09-29, behind the setting `workbench.modernUIFrostedGlass`, and only on overlays that come and go: quick input, menus, hovers, dialogs, notifications. Editors, panels and chat inputs are explicitly left solid ([README](https://github.com/microsoft/vscode/blob/810f80883aaac513572c70e621cc92c884c50263/src/vs/workbench/contrib/modernUI/README.md#L47-L56), [PR #337468](https://github.com/microsoft/vscode/pull/337468)).
- It turns on only with hardware GPU compositing, and falls back to solid for reduced transparency and high contrast ([`frostedGlass.contribution.ts` L90-98](https://github.com/microsoft/vscode/blob/810f80883aaac513572c70e621cc92c884c50263/src/vs/workbench/contrib/modernUI/electron-browser/frostedGlass.contribution.ts#L90-L98)).
- Vibrancy was never shipped. [PR #65215](https://github.com/microsoft/vscode/pull/65215#issuecomment-508532483) was closed in 2019 because of "exotic" Electron API and expected regressions.

**Others,** briefly:

- **Zed** (its own GPU UI, not Electron) puts an `NSVisualEffectView` under its content in the default mode, which blurs the desktop only ([`window.rs` L1857-1893](https://github.com/zed-industries/zed/blob/a84689073d296dfd39987bc7dd478e43ef76d83a/crates/gpui_macos/src/window.rs#L1857-L1893)).
- **Warp**'s blur slider blurs the background behind the window, and its docs warn that large radii "may affect performance, especially on Retina displays" ([docs](https://docs.warp.dev/terminal/appearance/size-opacity-blurring/)).
- **Linear, Arc, Slack, Discord, Notion, Figma, Raycast:** no primary source found, so nothing is claimed.

**The pattern:** apps that care keep live blur to things that come and go (menus, dialogs), and draw surfaces that stay on screen solid or with a pre-blurred image. Of the apps checked, only T3 Code blurs moving content under surfaces that stay on screen (its composer and its sticky headers), and it accepts the cost.

## 3. Electron's vibrancy

It cannot blur the Office.

- `setVibrancy` adds one `NSVisualEffectView` the size of the window, with the blending mode fixed to "behind window", inserted "underneath all other views" ([`native_window_mac.mm` L1480-1504](https://github.com/electron/electron/blob/v44.4.5/shell/browser/native_window_mac.mm#L1480-L1504)). It shows the desktop, blurred, through the transparent parts of the page.
- Apple's other mode, "within window", blurs content behind the view in the same window. Electron has no API for it. A native add-on could add such a view, but not between the canvas and the HTML panels: Chromium draws the whole page into one native view, so a view on top would blur the panels' text too, and it would have to follow each panel's position from another process. This is reasoning, not tested.

## 4. Glass drawn by the Office itself

### How it works

The spike (`glass=webgl`, file `engine/glass.ts`) does what games do:

1. **Shrink.** A pass in three.js's `EffectComposer`, just before the output pass, reads the frame while it is still in linear colour. It averages each 4 x 4 block of pixels into one: 2336 x 1744 becomes 584 x 436.
2. **Blur.** A Gaussian blur on the small image, across and then down, with the same strength as the CSS glass: 18.4 CSS pixels, the `--glass-blur` at the default glass level of 0.4. At a quarter of the size, that is a standard deviation of 9.2 pixels of the small image. The blur reaches 28 pixels on each side; bilinear filtering reads two pixels per tap, so each side takes 14 taps, plus one for the centre.
3. **Paint.** After the frame reaches the canvas, one instanced draw paints the blurred image into a rounded rectangle under each glass panel and each room label that shows. It applies the glass's saturation (1.1) and the same tone mapping as the frame.
4. The panels' HTML stays as it is: no `backdrop-filter`, the same 90% fill, rim and shadow on top. Nothing in the page has a backdrop filter, so macOS keeps compositing the layers.

Where the panels are: the stage reads the top bar's pills, the open card, the variant bar and the performance overlay with `getBoundingClientRect` at the start of each frame. The overlay already knows where it put each room label, so it returns their boxes with no layout read.

### What it costs, estimated before measuring

- **GPU:** about 20 million texture reads per frame (shrink 4 million, blur 15 million, paint under maybe 5% of the canvas). The frame itself draws the scene with hundreds of draw calls. This is a fraction of a millisecond on an M4 Max.
- **GPU process CPU:** four more draw calls per frame, against the frame's hundreds. Expected under one point of one core at 30 frames a second.
- **Renderer CPU:** a handful of `getBoundingClientRect` calls per frame. Expected under one point.
- **Memory:** two 584 x 436 half-float images, about 2 MB each. (#301 found that losing the hand-off holds 400 to 470 MB of GPU driver memory while frames keep coming.)

### What it cannot do

- **Glass over HTML.** Only what the canvas draws can show through. The thread drawer's composer and Requests dock sit over HTML, not over the canvas, so they must stay solid while the Office is open. Giving them a CSS blur would bring the whole cost back, because one blurred element anywhere is enough.
- **Fades.** The room labels and the card fade in and out with CSS. The WebGL glass under them appears and disappears at once, so a fade shows a short pop. v1 would pass each box's opacity, or let the overlay run the fade in script.
- **Panels that move while the Office stands still.** The glass is drawn only when the Office draws a frame. A panel that opens or moves while nothing else moves must ask the stage for one frame. That is one call, and one frame.
- **The exact CSS look.** CSS blurs only the pixels inside the element's box, and blurs after tone mapping. The spike samples a little beyond the box and blurs before tone mapping. Under a 90% fill the difference is hard to see.

### Why not a blurred image behind the HTML panels

#341 also asked about an image behind the panels, outside the canvas. It costs more than the quads, for no gain:

- the image must come from the canvas, so each frame must be copied out of the WebGL context into a second canvas or image, and that is extra work for both processes;
- a second canvas updated every frame is one more layer for macOS to composite;
- a CSS `filter: blur()` on that image keeps the hand-off (an ordinary blur is allowed), but the copy is the cost, not the blur.

The quads read the frame where it already is, on the GPU, in the same draw.

### Measured

Pending: the machine is busy measuring the Office for tonight's merge. The runs start after 23:50 CEST and their numbers replace this paragraph.

## 5. Does this change #301?

No. #301 chooses, for the thread screens, between keeping the blur (and its cost) and drawing persistent surfaces solid.

- The cause #301 found is confirmed in the source: one `backdrop-filter` turns off the hand-off for the whole window while frames keep coming (above).
- #301's lead 2, "can Chromium hand backdrop filters to Core Animation", is closed for now: no version, switch or feature does it in Chromium 152. Chromium's own fix (CL 8369961) is a prototype on private API. Worth watching, not waiting for.
- #301's lead 4, "glass without a live backdrop", only works where the app draws what is under the glass. The Office does, in WebGL. The thread screens have HTML under the composer, and the app cannot cheaply turn live HTML into an image each frame. So the WebGL glass does not transfer.
- What does transfer: VS Code and T3 Code both keep blur off large surfaces that stay on screen. That supports #301's option A (solid persistent surfaces, blur only on menus and popovers).

## 6. What changes in spec 17 rule 5 if glass comes back

Rule 5 lives in [spec 17 §Rules](https://github.com/theagenticage/hercule/blob/spec/office-v1/docs/spec/17-desktop-app.md#rules) on `spec/office-v1`. Two parts change.

**The first sentence** lists name tags as a glass surface, and so does #341. They are not: in the book (`.tag` in `docs/design/crew-bureau-2/office.css`), the prototype and v1, a name tag is a solid 90% `--raised` fill with no blur. The room labels are the Office's glass. Today it reads:

> It is allowed only on Bureau's glass surfaces: the header pills, the composer, popovers and name tags.

It becomes:

> It is allowed only on Bureau's glass surfaces: the header pills, the composer, popovers and the Office's room labels.

**The third bullet** ("So the window draws no blur while the Office is open") becomes:

> - So no element of the window has a `backdrop-filter` while the Office is open *(decided 2026-10-03, [#332](https://github.com/theagenticage/hercule/issues/332); amended YYYY-MM-DD, [#341](https://github.com/theagenticage/hercule/issues/341))*. The Office sets the glass level to 0 for the whole window, through the same tokens as Reduce transparency, and draws its own glass instead: each frame, it shrinks its rendered frame to a quarter, blurs it with the glass's blur and saturation, and paints it under its top bar's pills, its card and its room labels, beneath their HTML fill. The page then has no backdrop filter, so macOS keeps compositing the window's layers. The thread drawer's composer and Requests dock sit over HTML, not over the Office's frame, so they draw as solid Bureau surfaces, with the glass's rim and shadow. Reduce transparency turns the Office's own glass off too. Leaving the Office brings the CSS glass back.

The second bullet's last sentence ("This cause was read from the source, not measured...") becomes the measured result.

## The spike

Branch `spike/office-glass`, on top of #333's `spike/office-rendering`. Commit `89a69ad9` adds two switches to the prototype (`apps/desktop/src/renderer/specimens/office-prototype`):

- `glass=dot`: every backdrop blur off, plus one blurred 8 x 8 pixel dot in the middle of the window. Against `glass=0`, it measures what losing the hand-off costs, apart from blurring large areas.
- `glass=webgl`: every backdrop blur off, and the Office draws its own glass (`engine/glass.ts`).

The existing switches stay: `glass=0` (no blur) and `glass=top` (blur on the top bar's pills only). No switch means all of the prototype's glass.
