/**
 * SPIKE - frosted glass drawn by the office itself (#341), switched on with
 * `glass=webgl`.
 *
 * A CSS `backdrop-filter` over the office's canvas makes Chromium draw the
 * whole window itself on every frame the office draws: macOS can no longer
 * take the page's layers as overlays. This module draws the same frosted
 * look inside the office's own WebGL frame instead, so no element of the page
 * needs a backdrop filter:
 *
 * 1. Before tone mapping, a pass shrinks the office's frame to a quarter of
 *    its width and height, then blurs that copy with a Gaussian, first across
 *    and then down.
 * 2. After the frame reaches the canvas, one instanced draw paints the
 *    blurred copy into a rounded rectangle under each glass panel and room
 *    label. The panel's own HTML fill, about 90% opaque, sits on top of it.
 *
 * Only what the canvas draws can show through this glass. A panel over other
 * HTML, such as the thread drawer's composer, gets nothing from it.
 */
import {
  Float32BufferAttribute,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  OrthographicCamera,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from "three";
import { FullScreenQuad, Pass } from "three/examples/jsm/postprocessing/Pass.js";

/** A rounded rectangle to draw glass in, in CSS pixels from the canvas's top-left corner. */
export interface GlassBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly radius: number;
}

/** The blur's standard deviation in CSS pixels: `--glass-blur` at `--glass-level: 0.4` (tokens.css). */
const BLUR_CSS_PX = 18.4;
/** The saturation applied after the blur: `--glass-sat` at `--glass-level: 0.4`. */
const SATURATION = 1.1;
/** How many times smaller than the frame the blurred copy is, on each side. */
const DOWNSAMPLE = 4;
/** The most taps the blur shader reads on each side of a pixel, the centre included. */
const MAX_TAPS = 24;
/** The most rectangles one frame draws glass in. */
const MAX_BOXES = 64;

/** The page's panels drawn as glass: the top bar's pills, the open dossier card, the performance overlay and the variant switcher. */
const PANEL_SELECTOR =
  ".office-top .pill, .office-card[data-open='true'], .office-perf, .variant-bar";

const fullScreenVertex = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }`;

/**
 * Builds a Gaussian blur kernel with a standard deviation of `sigma` texels,
 * for a shader that samples with bilinear filtering. The first tap reads the
 * centre texel; each later tap reads two neighbouring texels at once, at the
 * point between them that weighs each one right, so 29 texels take 15 taps.
 * Returns the taps' offsets in texels and their weights, padded with zero
 * weights to `MAX_TAPS`.
 */
function buildBlurKernel(sigma: number): { offsets: number[]; weights: number[] } {
  const radius = Math.min(Math.ceil(sigma * 3), (MAX_TAPS - 1) * 2);
  const weighTexel = (index: number): number => Math.exp(-(index * index) / (2 * sigma * sigma));
  let total = weighTexel(0);
  for (let index = 1; index <= radius; index++) total += 2 * weighTexel(index);
  const offsets = [0];
  const weights = [weighTexel(0) / total];
  for (let index = 1; index <= radius; index += 2) {
    const near = weighTexel(index) / total;
    const far = index + 1 <= radius ? weighTexel(index + 1) / total : 0;
    offsets.push(index + far / (near + far));
    weights.push(near + far);
  }
  while (offsets.length < MAX_TAPS) {
    offsets.push(0);
    weights.push(0);
  }
  return { offsets, weights };
}

/** Each panel's corner radius in CSS pixels, read once: reading a computed style every frame costs a style pass. */
const radiusByPanel = new WeakMap<Element, number>();

/**
 * Reads where the page's glass panels sit now, relative to `canvas`. Returns
 * one box per panel that has a size.
 */
export function readPanelBoxes(canvas: HTMLCanvasElement): GlassBox[] {
  const origin = canvas.getBoundingClientRect();
  const boxes: GlassBox[] = [];
  for (const panel of document.querySelectorAll(PANEL_SELECTOR)) {
    const box = panel.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    let radius = radiusByPanel.get(panel);
    if (radius === undefined) {
      radius = parseFloat(getComputedStyle(panel).borderTopLeftRadius) || 0;
      radiusByPanel.set(panel, radius);
    }
    boxes.push({
      left: box.left - origin.left,
      top: box.top - origin.top,
      width: box.width,
      height: box.height,
      radius,
    });
  }
  return boxes;
}

/** A composer pass that hands the frame, before tone mapping, to a function, and leaves the frame as it is. */
class ReadFramePass extends Pass {
  private readonly readFrame: (renderer: WebGLRenderer, frame: Texture) => void;

  constructor(readFrame: (renderer: WebGLRenderer, frame: Texture) => void) {
    super();
    this.readFrame = readFrame;
    this.needsSwap = false;
  }

  override render(
    renderer: WebGLRenderer,
    _writeBuffer: WebGLRenderTarget,
    readBuffer: WebGLRenderTarget,
  ): void {
    this.readFrame(renderer, readBuffer.texture);
  }
}

/** The office's own glass: a pass that blurs the frame, and the draw that paints it under the panels. */
export class OfficeGlass {
  /** The pass to put in the composer just before its output pass, while the frame is still linear. */
  readonly pass = new ReadFramePass((renderer, frame) => this.blurFrame(renderer, frame));

  private readonly shrunk = new WebGLRenderTarget(1, 1, { type: HalfFloatType });
  private readonly across = new WebGLRenderTarget(1, 1, { type: HalfFloatType });
  private readonly quad = new FullScreenQuad();
  private readonly bufferSize = new Vector2(1, 1);
  private pixelRatio = 1;
  /** One texel of the frame, in texture coordinates. */
  private readonly frameTexel = new Vector2();
  /** One texel of the blurred copy along the direction the blur runs, in texture coordinates. */
  private readonly blurStep = new Vector2();

  private readonly shrinkMaterial = new ShaderMaterial({
    uniforms: { tFrame: { value: null }, uTexel: { value: this.frameTexel } },
    vertexShader: fullScreenVertex,
    fragmentShader: /* glsl */ `
      uniform sampler2D tFrame;
      uniform vec2 uTexel;
      varying vec2 vUv;
      void main() {
        // Four bilinear taps, each the mean of a 2 x 2 block of the frame,
        // make the mean of the 4 x 4 block this texel covers.
        gl_FragColor = 0.25 * (
          texture2D(tFrame, vUv + uTexel * vec2(-1.0, -1.0)) +
          texture2D(tFrame, vUv + uTexel * vec2(1.0, -1.0)) +
          texture2D(tFrame, vUv + uTexel * vec2(-1.0, 1.0)) +
          texture2D(tFrame, vUv + uTexel * vec2(1.0, 1.0)));
      }`,
    depthTest: false,
    depthWrite: false,
  });

  private readonly blurMaterial = new ShaderMaterial({
    defines: { MAX_TAPS: String(MAX_TAPS) },
    uniforms: {
      tInput: { value: null },
      uStep: { value: this.blurStep },
      uOffsets: { value: [] as number[] },
      uWeights: { value: [] as number[] },
    },
    vertexShader: fullScreenVertex,
    fragmentShader: /* glsl */ `
      uniform sampler2D tInput;
      uniform vec2 uStep;
      uniform float uOffsets[MAX_TAPS];
      uniform float uWeights[MAX_TAPS];
      varying vec2 vUv;
      void main() {
        vec4 sum = texture2D(tInput, vUv) * uWeights[0];
        for (int i = 1; i < MAX_TAPS; i++) {
          if (uWeights[i] == 0.0) break;
          vec2 offset = uStep * uOffsets[i];
          sum += (texture2D(tInput, vUv + offset) + texture2D(tInput, vUv - offset)) * uWeights[i];
        }
        gl_FragColor = sum;
      }`,
    depthTest: false,
    depthWrite: false,
  });

  private readonly boxAttribute = new InstancedBufferAttribute(new Float32Array(MAX_BOXES * 4), 4);
  private readonly radiusAttribute = new InstancedBufferAttribute(new Float32Array(MAX_BOXES), 1);
  private readonly boxGeometry = new InstancedBufferGeometry();
  private readonly boxMaterial = new ShaderMaterial({
    uniforms: {
      tBlur: { value: null },
      uResolution: { value: this.bufferSize },
      uSaturation: { value: SATURATION },
    },
    vertexShader: /* glsl */ `
      attribute vec4 aBox;
      attribute float aRadius;
      uniform vec2 uResolution;
      varying vec4 vBox;
      varying float vRadius;
      void main() {
        vBox = aBox;
        vRadius = aRadius;
        // The quad runs from 0 to 1; one pixel more on every side leaves room
        // for the smoothed edge.
        vec2 pixel = aBox.xy - 1.0 + position.xy * (aBox.zw + 2.0);
        gl_Position = vec4(pixel / uResolution * 2.0 - 1.0, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tBlur;
      uniform vec2 uResolution;
      uniform float uSaturation;
      varying vec4 vBox;
      varying float vRadius;
      void main() {
        // The signed distance from this pixel to the rounded rectangle's edge,
        // negative inside, gives the share of the pixel the glass covers.
        vec2 halfSize = vBox.zw * 0.5;
        float radius = min(vRadius, min(halfSize.x, halfSize.y));
        vec2 corner = abs(gl_FragCoord.xy - vBox.xy - halfSize) - halfSize + radius;
        float distance = length(max(corner, 0.0)) + min(max(corner.x, corner.y), 0.0) - radius;
        float coverage = clamp(0.5 - distance, 0.0, 1.0);
        if (coverage <= 0.0) discard;
        vec3 colour = texture2D(tBlur, gl_FragCoord.xy / uResolution).rgb;
        float luma = dot(colour, vec3(0.2126, 0.7152, 0.0722));
        gl_FragColor = vec4(max(mix(vec3(luma), colour, uSaturation), 0.0), coverage);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  private readonly boxScene = new Scene();
  private readonly boxCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);

  constructor() {
    this.boxGeometry.setAttribute(
      "position",
      new Float32BufferAttribute([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0], 3),
    );
    this.boxGeometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.boxGeometry.setAttribute("aBox", this.boxAttribute);
    this.boxGeometry.setAttribute("aRadius", this.radiusAttribute);
    this.boxGeometry.instanceCount = 0;
    const boxes = new Mesh(this.boxGeometry, this.boxMaterial);
    boxes.frustumCulled = false;
    this.boxScene.add(boxes);
    this.boxMaterial.uniforms.tBlur!.value = this.shrunk.texture;
  }

  /**
   * Sizes the blurred copy for a drawing buffer of `bufferSize` device pixels
   * drawn at `pixelRatio` device pixels per CSS pixel, and fits the blur to
   * that pixel ratio.
   */
  setSize(bufferSize: Vector2, pixelRatio: number): void {
    this.bufferSize.copy(bufferSize);
    this.pixelRatio = pixelRatio;
    const width = Math.max(1, Math.ceil(bufferSize.x / DOWNSAMPLE));
    const height = Math.max(1, Math.ceil(bufferSize.y / DOWNSAMPLE));
    this.shrunk.setSize(width, height);
    this.across.setSize(width, height);
    this.frameTexel.set(1 / bufferSize.x, 1 / bufferSize.y);
    const kernel = buildBlurKernel((BLUR_CSS_PX * pixelRatio) / DOWNSAMPLE);
    this.blurMaterial.uniforms.uOffsets!.value = kernel.offsets;
    this.blurMaterial.uniforms.uWeights!.value = kernel.weights;
  }

  /**
   * Paints the blurred frame into each of `boxes` on the canvas, which must
   * already hold this frame. Draws at most `MAX_BOXES` of them.
   */
  draw(renderer: WebGLRenderer, boxes: ReadonlyArray<GlassBox>): void {
    const count = Math.min(boxes.length, MAX_BOXES);
    const ratio = this.pixelRatio;
    for (let index = 0; index < count; index++) {
      const box = boxes[index]!;
      // WebGL counts y up from the bottom of the canvas; the page counts it down from the top.
      this.boxAttribute.setXYZW(
        index,
        box.left * ratio,
        this.bufferSize.y - (box.top + box.height) * ratio,
        box.width * ratio,
        box.height * ratio,
      );
      this.radiusAttribute.setX(index, box.radius * ratio);
    }
    this.boxAttribute.needsUpdate = true;
    this.radiusAttribute.needsUpdate = true;
    this.boxGeometry.instanceCount = count;
    if (count === 0) return;
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setRenderTarget(null);
    renderer.render(this.boxScene, this.boxCamera);
    renderer.autoClear = autoClear;
  }

  /** Frees the GPU's memory. */
  dispose(): void {
    this.shrunk.dispose();
    this.across.dispose();
    this.quad.dispose();
    this.shrinkMaterial.dispose();
    this.blurMaterial.dispose();
    this.boxMaterial.dispose();
    this.boxGeometry.dispose();
  }

  /** Shrinks `frame` into the quarter-size copy and blurs the copy, across and then down. */
  private blurFrame(renderer: WebGLRenderer, frame: Texture): void {
    this.shrinkMaterial.uniforms.tFrame!.value = frame;
    this.quad.material = this.shrinkMaterial;
    renderer.setRenderTarget(this.shrunk);
    this.quad.render(renderer);

    this.quad.material = this.blurMaterial;
    this.blurMaterial.uniforms.tInput!.value = this.shrunk.texture;
    this.blurStep.set(1 / this.shrunk.width, 0);
    renderer.setRenderTarget(this.across);
    this.quad.render(renderer);

    this.blurMaterial.uniforms.tInput!.value = this.across.texture;
    this.blurStep.set(0, 1 / this.shrunk.height);
    renderer.setRenderTarget(this.shrunk);
    this.quad.render(renderer);
  }
}
