/**
 * PROTOTYPE - the stage the office is drawn on: the WebGL renderer, the scene,
 * the camera, the light of the time of day, and a render loop that draws only
 * while something moves.
 *
 * The loop follows spec 17's performance rules: nothing draws unless a frame
 * listener asks for one (something moves) or `requestRender` is called (the
 * theme or the camera changed), and nothing draws while the window is hidden.
 */
import {
  AlwaysDepth,
  Box3,
  DepthTexture,
  DirectionalLight,
  HalfFloatType,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  ShaderMaterial,
  Matrix4,
  HemisphereLight,
  NeutralToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  PMREMGenerator,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
  type Texture,
} from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { GTAOPass } from "three/examples/jsm/postprocessing/GTAOPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { OfficeGlass, readPanelBoxes, type GlassBox } from "./glass";
import { isDarkTheme, readColor, readToken, refreshPalette, writeOklch } from "./palette";

/** How much the GPU is asked to do. */
export type Quality = "low" | "medium" | "high";

/** The light the office is drawn in. `auto` follows the theme: day in a light theme, evening in a dark one. */
export type TimeOfDay = "auto" | "morning" | "noon" | "evening" | "night";

/** What a frame listener is told about the frame being drawn. */
export interface Frame {
  /** Seconds since the previous drawn frame, at most 1/20 s. */
  readonly dt: number;
  /** Seconds since the stage started. */
  readonly time: number;
}

/**
 * A listener called before each drawn frame. It returns true while it still
 * moves something and wants the next frame drawn too.
 */
export type FrameListener = (frame: Frame) => boolean;

/** What the performance overlay shows. */
export interface StageStats {
  /** Frames drawn in the last second. 0 while nothing moves. */
  readonly fps: number;
  /** The CPU time of the last frame, listeners and draw calls together, in ms. */
  readonly cpuMs: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  /** Every frame drawn since the stage started. */
  readonly framesDrawn: number;
  /** The drawing buffer's size in device pixels. */
  readonly bufferSize: string;
  readonly quality: Quality;
}

/** The light settings of one time of day. */
interface Light {
  /** The sun's direction: azimuth from north, clockwise, and elevation, both in degrees. */
  readonly azimuth: number;
  readonly elevation: number;
  readonly sunIntensity: number;
  /** The sun's colour, as an OKLCH lightness, chroma and hue. */
  readonly sun: readonly [number, number, number];
  readonly skyIntensity: number;
  /**
   * The sky light's hue in place of the theme's, or undefined to follow the
   * theme. Night takes a moonlit blue in every theme, so it reads as night
   * even where the theme's rooms are pale.
   */
  readonly skyHue?: number;
  readonly environment: number;
  /**
   * Scales the sky and the environment in a light theme, or 1 when undefined.
   * A light theme paints its rooms pale, so the same light that reads as dusk
   * in a dark theme reads as an overcast day in a light one.
   */
  readonly lightThemeScale?: number;
}

const LIGHTS: Readonly<Record<Exclude<TimeOfDay, "auto">, Light>> = {
  morning: {
    azimuth: 60,
    elevation: 24,
    sunIntensity: 2.6,
    sun: [0.95, 0.06, 75],
    skyIntensity: 1.05,
    environment: 0.32,
  },
  noon: {
    azimuth: 330,
    elevation: 52,
    sunIntensity: 2.4,
    sun: [0.98, 0.025, 95],
    skyIntensity: 1.15,
    environment: 0.36,
  },
  evening: {
    azimuth: 285,
    elevation: 16,
    sunIntensity: 1.9,
    sun: [0.86, 0.11, 58],
    skyIntensity: 0.85,
    environment: 0.3,
    lightThemeScale: 0.65,
  },
  night: {
    azimuth: 320,
    elevation: 38,
    sunIntensity: 0.55,
    sun: [0.82, 0.04, 250],
    skyIntensity: 0.38,
    skyHue: 255,
    environment: 0.12,
    lightThemeScale: 0.45,
  },
};

/** The settings each quality level changes. */
const QUALITY: Readonly<
  Record<Quality, { readonly pixelRatio: number; readonly shadowMap: number; readonly ao: boolean }>
> = {
  low: { pixelRatio: 1, shadowMap: 1024, ao: false },
  medium: { pixelRatio: 1.5, shadowMap: 2048, ao: false },
  high: { pixelRatio: 2, shadowMap: 4096, ao: true },
};

/**
 * SPIKE - the power experiments, each switched by a URL parameter so one
 * build can be measured in every combination:
 *
 * - `cap=raf|timer|timerraf` with `fps=30`: caps the frame rate. `raf` keeps
 *   asking for animation frames and skips the ones that come too soon;
 *   `timer` waits on a timer and draws in the timer's task; `timerraf` waits
 *   on a timer and then asks for one animation frame.
 * - `pr=1`: the pixel ratio, in place of the quality level's.
 * - `shadows=static`: the sun's shadow map is drawn only when the building or
 *   the light changes, and colleagues cast no shadow into it.
 * - `cache=1`: the still building is drawn once into a colour and a depth
 *   texture; each frame copies both to the canvas and draws only the
 *   colleagues over them. Ambient occlusion is drawn into the copy only when
 *   the camera rests.
 * - `lowpower=1`: asks for the low-power GPU.
 * - `glass=0`: no backdrop blur on the office's panels and labels.
 * - `glass=top`: backdrop blur on the top bar's pills only, to measure
 *   whether one blurred element costs as much as all of them.
 * - `glass=dot`: no backdrop blur on the panels, and one blurred 8 x 8 pixel
 *   dot in the middle of the window. It measures what any backdrop filter
 *   costs, apart from the cost of blurring large areas.
 * - `glass=webgl`: no backdrop blur on the page; the office draws its own
 *   glass under the panels and room labels instead (engine/glass.ts).
 * - `gputime=1`: reads the GPU time of each frame with a timer query.
 * - `ao=off`: no ambient occlusion, whatever the quality.
 */
const spikeParams = new URLSearchParams(location.search);
export const SPIKE = {
  cap: spikeParams.get("cap") ?? "none",
  fps: Number(spikeParams.get("fps") ?? 30),
  pixelRatio: spikeParams.has("pr") ? Number(spikeParams.get("pr")) : null,
  staticShadows: spikeParams.get("shadows") === "static" || spikeParams.get("cache") === "1",
  cache: spikeParams.get("cache") === "1",
  lowPower: spikeParams.get("lowpower") === "1",
  glass: (spikeParams.get("glass") ?? "all") as "all" | "0" | "top" | "dot" | "webgl",
  gpuTime: spikeParams.get("gputime") === "1",
  merge: spikeParams.get("merge") === "1",
  animHz: Number(spikeParams.get("animhz") ?? 0),
  aoAlways: spikeParams.get("ao") === "always",
  aoOff: spikeParams.get("ao") === "off",
} as const;

/** The layer the still building is drawn on in cache mode; colleagues stay on layer 0. */
export const STATIC_LAYER = 1;

/** What the measuring harness reads, accumulated since the stage started. */
export interface SpikeCounters {
  frames: number;
  cpuMs: number;
  listenersMs: number;
  renderMs: number;
  gpuMs: number;
  gpuFrames: number;
  staticRedraws: number;
  skippedRafs: number;
  drawCalls: number;
  triangles: number;
}

declare global {
  interface Window {
    /** The mounted office or lab page, for the screenshot tool and the console. */
    office?: { readonly stage: Stage };
  }
}

/** The stage: one WebGL canvas filling `container`. */
export class Stage {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(28, 1, 0.5, 400);
  readonly sun = new DirectionalLight();
  readonly sky = new HemisphereLight();

  private readonly composer: EffectComposer;
  private readonly aoPass: GTAOPass;
  /** When the last frame was drawn, or null while the loop is stopped. */
  private lastFrameAt: number | null = null;
  /** Seconds of animation so far. It does not advance while the loop is stopped. */
  private elapsed = 0;
  private readonly listeners = new Set<FrameListener>();
  private readonly resizeObserver: ResizeObserver;
  private readonly environmentTexture: Texture;
  private readonly bounds = new Box3(new Vector3(-10, 0, -10), new Vector3(10, 4, 10));
  private frameRequest = 0;
  private quality: Quality = "high";
  private timeOfDay: TimeOfDay = "auto";
  private framesDrawn = 0;
  private recentFrames: number[] = [];
  private lastCpuMs = 0;

  private readonly container: HTMLElement;
  /** SPIKE - the glass the office draws itself, with `glass=webgl`. */
  private readonly glass: OfficeGlass | null = SPIKE.glass === "webgl" ? new OfficeGlass() : null;
  /** SPIKE - returns the room labels showing now, for the glass the office draws itself. */
  glassLabels: (() => GlassBox[]) | null = null;

  // SPIKE fields.
  readonly spike: SpikeCounters = {
    frames: 0,
    cpuMs: 0,
    listenersMs: 0,
    renderMs: 0,
    gpuMs: 0,
    gpuFrames: 0,
    staticRedraws: 0,
    skippedRafs: 0,
    drawCalls: 0,
    triangles: 0,
  };
  private readonly gl: WebGL2RenderingContext;
  private readonly timerExt: unknown;
  private readonly pendingQueries: WebGLQuery[] = [];
  private lastDrawAt = 0;
  private capTimer = 0;
  private staticDirty = true;
  private aoPending = false;
  private readonly lastView = new Matrix4();
  private readonly lastProjection = new Matrix4();
  private staticTarget: WebGLRenderTarget | null = null;
  private staticAoTarget: WebGLRenderTarget | null = null;
  private readonly copyScene = new Scene();
  private readonly copyCamera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly copyMaterial = new ShaderMaterial({
    uniforms: { tColor: { value: null }, tDepth: { value: null } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D tColor;
      uniform sampler2D tDepth;
      varying vec2 vUv;
      void main() {
        gl_FragColor = texture2D(tColor, vUv);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        gl_FragDepth = texture2D(tDepth, vUv).x;
      }`,
    depthTest: true,
    depthWrite: true,
    depthFunc: AlwaysDepth,
  });

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new WebGLRenderer({
      antialias: SPIKE.cache,
      powerPreference: SPIKE.lowPower ? "low-power" : "high-performance",
    });
    if (SPIKE.staticShadows) this.renderer.shadowMap.autoUpdate = false;
    if (SPIKE.glass !== "all") document.documentElement.style.setProperty("--glass-filter", "none");
    const blur = "blur(var(--glass-blur)) saturate(var(--glass-sat))";
    if (SPIKE.glass === "top") {
      const style = document.createElement("style");
      style.textContent = `.office-top .pill { -webkit-backdrop-filter: ${blur}; backdrop-filter: ${blur}; }`;
      document.head.append(style);
    }
    if (SPIKE.glass === "dot") {
      const dot = document.createElement("div");
      dot.style.cssText = `position: fixed; left: 50%; top: 50%; z-index: 100; width: 8px; height: 8px; pointer-events: none; backdrop-filter: ${blur};`;
      document.body.append(dot);
    }
    this.sun.layers.enableAll();
    this.sky.layers.enableAll();
    this.gl = this.renderer.getContext() as WebGL2RenderingContext;
    this.timerExt = SPIKE.gpuTime ? this.gl.getExtension("EXT_disjoint_timer_query_webgl2") : null;
    (window as unknown as { spikeGpuTimer: boolean }).spikeGpuTimer = this.timerExt !== null;
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.toneMappingExposure = 1;
    // The stats count every pass of a frame, so the stage resets them once per frame.
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.domElement.className = "office-canvas";
    container.append(this.renderer.domElement);

    const pmrem = new PMREMGenerator(this.renderer);
    this.environmentTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = this.environmentTexture;

    this.sun.castShadow = true;
    this.sun.shadow.bias = -0.0005;
    this.sun.shadow.normalBias = 0.025;
    this.sun.shadow.radius = 3;
    this.sun.shadow.blurSamples = 12;
    this.scene.add(this.sun, this.sun.target, this.sky);

    // The composer draws into a multisampled target, so edges stay smooth
    // with the ambient occlusion pass in the chain.
    const target = new WebGLRenderTarget(1, 1, { type: HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(this.renderer, target);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.aoPass = new GTAOPass(this.scene, this.camera, 1, 1);
    this.aoPass.updateGtaoMaterial({
      radius: 0.55,
      distanceExponent: 1.4,
      thickness: 1.2,
      scale: 1,
      samples: 16,
    });
    this.aoPass.updatePdMaterial({
      lumaPhi: 10,
      depthPhi: 2,
      normalPhi: 3,
      radius: 6,
      rings: 2,
      samples: 16,
    });
    this.aoPass.blendIntensity = 0.85;
    this.composer.addPass(this.aoPass);
    if (this.glass !== null) this.composer.addPass(this.glass.pass);
    this.composer.addPass(new OutputPass());

    const copyQuad = new Mesh(new PlaneGeometry(2, 2), this.copyMaterial);
    copyQuad.frustumCulled = false;
    this.copyScene.add(copyQuad);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.applyQuality();
    this.applyTheme();
    this.resize();
  }

  /**
   * Calls `listener` before each drawn frame, and draws the next frame too
   * while it returns true. Returns the function that removes it.
   */
  onFrame(listener: FrameListener): () => void {
    this.listeners.add(listener);
    this.requestRender();
    return () => this.listeners.delete(listener);
  }

  /** Draws one more frame, unless one is already on its way or the window is hidden. */
  requestRender(): void {
    if (this.frameRequest !== 0 || this.capTimer !== 0 || document.hidden) return;
    if (SPIKE.cap === "timer" || SPIKE.cap === "timerraf") {
      const wait = Math.max(0, this.lastDrawAt + 1000 / SPIKE.fps - performance.now());
      this.capTimer = window.setTimeout(() => {
        this.capTimer = 0;
        if (document.hidden) return;
        if (SPIKE.cap === "timer") this.drawFrame();
        else this.frameRequest = requestAnimationFrame(this.drawFrame);
      }, wait);
      return;
    }
    this.frameRequest = requestAnimationFrame(this.drawFrame);
  }

  /** SPIKE - marks the cached building as out of date, so the next frame draws it again. */
  invalidateStatic(): void {
    this.staticDirty = true;
    if (SPIKE.staticShadows) this.renderer.shadowMap.needsUpdate = true;
    this.requestRender();
  }

  /** Sets the quality level and draws again. */
  setQuality(quality: Quality): void {
    this.quality = quality;
    this.applyQuality();
    this.resize();
  }

  /** Sets the time of day and draws again. */
  setTimeOfDay(timeOfDay: TimeOfDay): void {
    this.timeOfDay = timeOfDay;
    this.applyTheme();
  }

  /** Returns the time of day the stage draws now, with `auto` resolved from the theme. */
  resolveTimeOfDay(): Exclude<TimeOfDay, "auto"> {
    if (this.timeOfDay !== "auto") return this.timeOfDay;
    return isDarkTheme() ? "evening" : "morning";
  }

  /**
   * Sets the box the sun's shadow must cover: the whole office. A tighter
   * box gives sharper shadows.
   */
  setShadowBounds(bounds: Box3): void {
    this.bounds.copy(bounds);
    this.applyTheme();
  }

  /** Repaints every material and relights the scene from the current theme. */
  applyTheme(): void {
    refreshPalette();
    const light = LIGHTS[this.resolveTimeOfDay()];
    const background = readColor("surface");
    this.scene.background = background;
    // The sky light takes its hue from the theme but not its lightness: a
    // dark theme paints its rooms dark already, and a dark light on top would
    // draw them nearly black. How bright the sky is comes from the time of day.
    const sunToken = readToken("room-sun");
    writeOklch(
      this.sky.color,
      light.skyHue === undefined
        ? { l: 0.96, c: Math.min(sunToken.c, 0.05), h: sunToken.h }
        : { l: 0.9, c: 0.06, h: light.skyHue },
    );
    const floorToken = readToken("room-floor");
    writeOklch(this.sky.groundColor, { l: 0.62, c: floorToken.c, h: floorToken.h });
    const scale = isDarkTheme() ? 1 : (light.lightThemeScale ?? 1);
    this.sky.intensity = light.skyIntensity * scale;
    this.scene.environmentIntensity = light.environment * scale;
    const [l, c, h] = light.sun;
    writeOklch(this.sun.color, { l, c, h });
    this.sun.intensity = light.sunIntensity;
    this.placeSun(light);
    this.invalidateStatic();
  }

  /** Returns what the performance overlay shows. */
  readStats(): StageStats {
    const info = this.renderer.info;
    const size = this.renderer.getDrawingBufferSize(new Vector2());
    const now = performance.now();
    this.recentFrames = this.recentFrames.filter((time) => now - time < 1000);
    return {
      fps: this.recentFrames.length,
      cpuMs: this.lastCpuMs,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      framesDrawn: this.framesDrawn,
      bufferSize: `${String(size.x)} × ${String(size.y)}`,
      quality: this.quality,
    };
  }

  /** Stops drawing and frees the GPU's memory. */
  dispose(): void {
    cancelAnimationFrame(this.frameRequest);
    this.resizeObserver.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    this.composer.dispose();
    this.aoPass.dispose();
    this.glass?.dispose();
    this.environmentTexture.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  /** Points the sun along a time of day's direction and fits its shadow to the office. */
  private placeSun(light: Light): void {
    const center = this.bounds.getCenter(new Vector3());
    const radius = this.bounds.getSize(new Vector3()).length() / 2;
    const azimuth = (light.azimuth * Math.PI) / 180;
    const elevation = (light.elevation * Math.PI) / 180;
    // North is -z, east is +x.
    const direction = new Vector3(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      -Math.cos(azimuth) * Math.cos(elevation),
    );
    this.sun.position.copy(center).addScaledVector(direction, radius * 2);
    this.sun.target.position.copy(center);
    const shadow = this.sun.shadow.camera;
    shadow.left = -radius;
    shadow.right = radius;
    shadow.top = radius;
    shadow.bottom = -radius;
    shadow.near = radius * 0.5;
    shadow.far = radius * 3.5;
    shadow.updateProjectionMatrix();
  }

  private applyQuality(): void {
    const settings = QUALITY[this.quality];
    this.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, SPIKE.pixelRatio ?? settings.pixelRatio),
    );
    this.sun.shadow.mapSize.set(settings.shadowMap, settings.shadowMap);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.aoPass.enabled = settings.ao && !SPIKE.aoOff;
    this.invalidateStatic();
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
    this.glass?.setSize(
      this.renderer.getDrawingBufferSize(new Vector2()),
      this.renderer.getPixelRatio(),
    );
    if (SPIKE.cache) this.resizeStaticTargets();
    this.invalidateStatic();
  }

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) {
      cancelAnimationFrame(this.frameRequest);
      this.frameRequest = 0;
      window.clearTimeout(this.capTimer);
      this.capTimer = 0;
      this.lastFrameAt = null;
    } else {
      this.requestRender();
    }
  };

  private readonly drawFrame = (): void => {
    this.frameRequest = 0;
    const started = performance.now();
    if (SPIKE.cap === "raf" && started - this.lastDrawAt < 1000 / SPIKE.fps - 4) {
      // Too soon: skip this animation frame and wait for the next one.
      this.spike.skippedRafs++;
      this.frameRequest = requestAnimationFrame(this.drawFrame);
      return;
    }
    this.lastDrawAt = started;
    // The first frame after a pause advances by one 60 Hz frame, not by the whole pause.
    const dt =
      this.lastFrameAt === null ? 1 / 60 : Math.min((started - this.lastFrameAt) / 1000, 1 / 10);
    this.lastFrameAt = started;
    this.elapsed += dt;
    const frame: Frame = { dt, time: this.elapsed };
    this.renderer.info.reset();
    // The panels are read before the listeners write this frame's styles, so
    // reading them does not make the page lay out a second time.
    const glassBoxes = this.glass === null ? [] : readPanelBoxes(this.renderer.domElement);
    let again = false;
    for (const listener of this.listeners) again = listener(frame) || again;
    if (this.glass !== null) {
      glassBoxes.push(...(this.glassLabels?.() ?? []));
      // With no glass on screen, the frame need not be blurred.
      this.glass.pass.enabled = glassBoxes.length > 0;
    }
    const listened = performance.now();
    const query = this.beginGpuQuery();
    if (SPIKE.cache) this.drawCached(dt);
    else this.composer.render(dt);
    this.glass?.draw(this.renderer, glassBoxes);
    if (query !== null) {
      this.gl.endQuery(0x88bf /* TIME_ELAPSED_EXT */);
      this.pendingQueries.push(query);
    }
    this.readGpuQueries();
    this.framesDrawn++;
    const ended = performance.now();
    this.recentFrames.push(ended);
    this.lastCpuMs = ended - started;
    this.spike.frames++;
    this.spike.cpuMs += ended - started;
    this.spike.listenersMs += listened - started;
    this.spike.renderMs += ended - listened;
    this.spike.drawCalls = this.renderer.info.render.calls;
    this.spike.triangles = this.renderer.info.render.triangles;
    if (again) {
      this.requestRender();
    } else {
      this.lastFrameAt = null;
    }
  };

  /** SPIKE - starts a GPU timer query for this frame, or returns null without the extension. */
  private beginGpuQuery(): WebGLQuery | null {
    if (this.timerExt === null) return null;
    const query = this.gl.createQuery();
    this.gl.beginQuery(0x88bf /* TIME_ELAPSED_EXT */, query);
    return query;
  }

  /** SPIKE - adds the GPU time of every finished query to the counters. */
  private readGpuQueries(): void {
    const gl = this.gl;
    while (this.pendingQueries.length > 0) {
      const query = this.pendingQueries[0]!;
      if (!(gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE) as boolean)) return;
      const disjoint = gl.getParameter(0x8fbb /* GPU_DISJOINT_EXT */) as boolean;
      const ns = gl.getQueryParameter(query, gl.QUERY_RESULT) as number;
      if (!disjoint) {
        this.spike.gpuMs += ns / 1e6;
        this.spike.gpuFrames++;
      }
      gl.deleteQuery(query);
      this.pendingQueries.shift();
    }
  }

  /** SPIKE - sizes the targets the still building is drawn into to the drawing buffer. */
  private resizeStaticTargets(): void {
    const size = this.renderer.getDrawingBufferSize(new Vector2());
    this.staticTarget?.dispose();
    this.staticAoTarget?.dispose();
    this.staticTarget = new WebGLRenderTarget(size.x, size.y, {
      type: HalfFloatType,
      samples: 4,
      depthTexture: new DepthTexture(size.x, size.y),
    });
    this.staticAoTarget = new WebGLRenderTarget(size.x, size.y, { type: HalfFloatType });
    this.aoPass.setSize(size.x, size.y);
  }

  /**
   * SPIKE - draws one frame in cache mode: the still building again only when
   * it or the camera changed, then a copy of it and the colleagues over it.
   */
  private drawCached(dt: number): void {
    const renderer = this.renderer;
    const camera = this.camera;
    camera.updateMatrixWorld();
    const moved =
      !this.lastView.equals(camera.matrixWorld) ||
      !this.lastProjection.equals(camera.projectionMatrix);
    if (moved) {
      this.lastView.copy(camera.matrixWorld);
      this.lastProjection.copy(camera.projectionMatrix);
    }
    const wantsAo = this.aoPass.enabled;
    // While the camera moves, the building is drawn without ambient occlusion;
    // once it rests, one more drawing adds it.
    const drawAo = wantsAo && (SPIKE.aoAlways || !moved);
    if (moved || this.staticDirty || (this.aoPending && !moved)) {
      if (this.staticTarget === null) this.resizeStaticTargets();
      camera.layers.set(STATIC_LAYER);
      renderer.setRenderTarget(this.staticTarget);
      renderer.clear();
      renderer.render(this.scene, camera);
      if (drawAo) this.aoPass.render(renderer, this.staticAoTarget!, this.staticTarget!, 0, false);
      camera.layers.set(0);
      this.aoPending = wantsAo && !drawAo;
      this.staticDirty = false;
      this.spike.staticRedraws++;
      this.copyMaterial.uniforms.tColor!.value = drawAo
        ? this.staticAoTarget!.texture
        : this.staticTarget!.texture;
      this.copyMaterial.uniforms.tDepth!.value = this.staticTarget!.depthTexture;
      if (this.aoPending) this.requestRender();
    }
    renderer.setRenderTarget(null);
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clear();
    renderer.render(this.copyScene, this.copyCamera);
    const background = this.scene.background;
    this.scene.background = null;
    renderer.render(this.scene, camera);
    this.scene.background = background;
    renderer.autoClear = autoClear;
    void dt;
  }
}
