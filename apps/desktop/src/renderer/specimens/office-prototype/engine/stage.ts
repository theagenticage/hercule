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
  Box3,
  DirectionalLight,
  HalfFloatType,
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

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new WebGLRenderer({ antialias: false, powerPreference: "high-performance" });
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
    this.composer.addPass(new OutputPass());

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
    if (this.frameRequest !== 0 || document.hidden) return;
    this.frameRequest = requestAnimationFrame(this.drawFrame);
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
    this.requestRender();
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
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, settings.pixelRatio));
    this.sun.shadow.mapSize.set(settings.shadowMap, settings.shadowMap);
    this.sun.shadow.map?.dispose();
    this.sun.shadow.map = null;
    this.aoPass.enabled = settings.ao;
    this.requestRender();
  }

  private resize(): void {
    const width = Math.max(1, this.container.clientWidth);
    const height = Math.max(1, this.container.clientHeight);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height);
    this.composer.setPixelRatio(this.renderer.getPixelRatio());
    this.composer.setSize(width, height);
    this.requestRender();
  }

  private readonly onVisibilityChange = (): void => {
    if (document.hidden) {
      cancelAnimationFrame(this.frameRequest);
      this.frameRequest = 0;
      this.lastFrameAt = null;
    } else {
      this.requestRender();
    }
  };

  private readonly drawFrame = (): void => {
    this.frameRequest = 0;
    const started = performance.now();
    // The first frame after a pause advances by one 60 Hz frame, not by the whole pause.
    const dt =
      this.lastFrameAt === null ? 1 / 60 : Math.min((started - this.lastFrameAt) / 1000, 1 / 20);
    this.lastFrameAt = started;
    this.elapsed += dt;
    const frame: Frame = { dt, time: this.elapsed };
    this.renderer.info.reset();
    let again = false;
    for (const listener of this.listeners) again = listener(frame) || again;
    this.composer.render(dt);
    this.framesDrawn++;
    this.recentFrames.push(performance.now());
    this.lastCpuMs = performance.now() - started;
    if (again) {
      this.requestRender();
    } else {
      this.lastFrameAt = null;
    }
  };
}
