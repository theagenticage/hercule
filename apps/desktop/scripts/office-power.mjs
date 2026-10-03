/**
 * SPIKE - measures what the office prototype costs inside Electron.
 *
 * Run with the repo's Electron:
 *   apps/desktop/node_modules/.bin/electron apps/desktop/scripts/office-power.mjs \
 *     --url 'http://127.0.0.1:5318/specimens/office-prototype/index.html?flow=0' \
 *     --label baseline [--settle 25] [--sample 10] [--mode visible|hidden|minimized|covered|blurred] [--pan]
 *
 * It opens one 1440 x 900 window on the built-in display, waits `settle`
 * seconds, then samples for `sample` seconds:
 * - CPU and idle wakeups per process, from `app.getAppMetrics()`;
 * - energy impact per process, from `top`'s POWER column;
 * - the GPU's device utilisation, from `ioreg` (the whole GPU, all apps);
 * - frames drawn, JavaScript time and GPU time per frame, from the page.
 * It prints one JSON line and quits.
 */
import { app, BrowserWindow, screen } from "electron";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? fallback : args[index + 1];
};
const flag = (name) => args.includes(`--${name}`);

const url = option("url");
const label = option("label", "run");
const settle = Number(option("settle", "25"));
const sample = Number(option("sample", "10"));
const mode = option("mode", "visible");
const pan = flag("pan");
const shot = option("shot");

const userData = mkdtempSync(join(tmpdir(), "office-power-"));
app.setPath("userData", userData);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Returns the GPU's device utilisation in percent, read once from ioreg. */
async function readGpuUtilisation() {
  const { stdout } = await run("ioreg", ["-r", "-d", "1", "-w", "0", "-c", "IOAccelerator"]);
  const match = /"Device Utilization %"=(\d+)/.exec(stdout);
  return match === null ? null : Number(match[1]);
}

/** Returns each pid's POWER from `top`, sampled over `seconds`. */
async function readEnergyImpact(pids, seconds) {
  const pidArgs = pids.flatMap((pid) => ["-pid", String(pid)]);
  const { stdout } = await run("top", [
    "-l",
    "2",
    "-s",
    String(seconds),
    ...pidArgs,
    "-stats",
    "pid,cpu,idlew,power",
  ]);
  // The second sample is the one that covers the interval.
  const blocks = stdout.split(/\n(?=Processes:)/);
  const last = blocks[blocks.length - 1];
  const result = {};
  for (const line of last.split("\n")) {
    const match = /^\s*(\d+)\s+([\d.]+)\s+(\d+)\+?\s+([\d.]+)/.exec(line);
    if (match !== null) result[match[1]] = { cpu: Number(match[2]), power: Number(match[4]) };
  }
  return result;
}

/** Returns each pid's CPU time so far in seconds, as `ps` reports it. */
async function readPsTimes(pids) {
  const { stdout } = await run("ps", ["-o", "pid=,time=", "-p", pids.join(",")]);
  const result = {};
  for (const line of stdout.trim().split("\n")) {
    const [pid, time] = line.trim().split(/\s+/);
    const parts = time.split(":").map(Number);
    result[pid] = parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  }
  return result;
}

app.whenReady().then(async () => {
  const internal = screen.getAllDisplays().find((display) => display.internal) ?? screen.getPrimaryDisplay();
  const area = internal.workArea;
  const window = new BrowserWindow({
    x: area.x + 20,
    y: area.y + 20,
    width: 1440,
    height: 900,
    show: true,
    webPreferences: { backgroundThrottling: true },
  });
  await window.loadURL(url);
  // Waits for the office to mount.
  for (let i = 0; i < 100; i++) {
    const ready = await window.webContents.executeJavaScript("window.office !== undefined");
    if (ready) break;
    await sleep(100);
  }

  let cover = null;
  let other = null;
  if (mode === "hidden") window.hide();
  if (mode === "minimized") {
    // A window minimized before it is on screen stays up, so this waits for it to show first.
    app.focus({ steal: true });
    await sleep(1000);
    window.minimize();
    await sleep(1000);
    console.log(`minimized: ${window.isMinimized()}`);
  }
  if (mode === "covered") {
    cover = new BrowserWindow({
      x: area.x,
      y: area.y,
      width: area.width,
      height: area.height,
      show: true,
      backgroundColor: "#202020",
    });
    await cover.loadURL("data:text/html,<body style='background:%23202020'></body>");
  }
  if (mode === "blurred") {
    // A small window of the same app takes the focus; the office stays in view beside it.
    other = new BrowserWindow({ x: area.x + area.width - 320, y: area.y + area.height - 220, width: 300, height: 200, show: true });
    await other.loadURL("data:text/html,<body>other</body>");
    other.focus();
  }

  await sleep(settle * 1000);
  if (shot !== undefined) {
    const image = await window.webContents.capturePage();
    writeFileSync(shot, image.toPNG());
  }

  if (pan) {
    await window.webContents.executeJavaScript(
      "window.spikePan = setInterval(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q' })), 900); 0",
    );
    await sleep(1500);
  }

  const readPage = () =>
    window.webContents.executeJavaScript(`(() => {
      if (window.office === undefined) return { frames: 0, cpuMs: 0, listenersMs: 0, renderMs: 0, gpuMs: 0, gpuFrames: 0, staticRedraws: 0, skippedRafs: 0, visibility: document.visibilityState, hasFocus: document.hasFocus(), heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576) };
      const stage = window.office.stage;
      const s = stage.spike;
      return {
        ...s,
        visibility: document.visibilityState,
        hasFocus: document.hasFocus(),
        buffer: stage.readStats().bufferSize,
        gpuTimer: window.spikeGpuTimer === true,
        merged: window.spikeMerged ?? null,
        heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576),
      };
    })()`);

  app.getAppMetrics(); // starts the interval the next call reports on
  const before = await readPage();
  const startedAt = performance.now();
  const pids = app
    .getAppMetrics()
    .filter((metric) => metric.type === "GPU" || metric.type === "Tab" || metric.type === "Browser")
    .map((metric) => metric.pid);
  const startMetrics = app.getAppMetrics();
  const psStart = await readPsTimes(pids);
  const psStartedAt = performance.now();
  const energyPromise = readEnergyImpact(pids, sample);
  const gpuReadings = [];
  while (performance.now() - startedAt < sample * 1000) {
    const value = await readGpuUtilisation();
    if (value !== null) gpuReadings.push(value);
    await sleep(1000);
  }
  const metrics = app.getAppMetrics();
  const psEnd = await readPsTimes(pids);
  const psSeconds = (performance.now() - psStartedAt) / 1000;
  const psShare = (pid) => Number((((psEnd[pid] - psStart[pid]) / psSeconds) * 100).toFixed(1));
  const seconds = (performance.now() - startedAt) / 1000;
  const after = await readPage();
  const energy = await energyPromise;

  const byType = (type) => metrics.find((metric) => metric.type === type);
  /** Returns a process's CPU time over the sample as a share of one core, in percent. */
  const coreShare = (metric) => {
    const start = startMetrics.find((each) => each.pid === metric.pid);
    return Number((((metric.cpu.cumulativeCPUUsage - start.cpu.cumulativeCPUUsage) / seconds) * 100).toFixed(1));
  };
  const gpu = byType("GPU");
  const renderer = metrics.find((metric) => metric.type === "Tab" && metric.pid === window.webContents.getOSProcessId());
  const browser = byType("Browser");
  const frames = after.frames - before.frames;
  const per = (field) => (frames === 0 ? 0 : (after[field] - before[field]) / frames);
  const gpuFrames = after.gpuFrames - before.gpuFrames;
  const result = {
    label,
    mode,
    pan,
    url: url.replace(/^.*\?/, "?"),
    displayHz: internal.displayFrequency,
    seconds: Number(seconds.toFixed(1)),
    fps: Number((frames / seconds).toFixed(1)),
    jsMsPerFrame: Number(per("cpuMs").toFixed(2)),
    listenersMsPerFrame: Number(per("listenersMs").toFixed(2)),
    renderMsPerFrame: Number(per("renderMs").toFixed(2)),
    gpuMsPerFrame: gpuFrames === 0 ? null : Number(((after.gpuMs - before.gpuMs) / gpuFrames).toFixed(2)),
    staticRedrawsPerSecond: Number(((after.staticRedraws - before.staticRedraws) / seconds).toFixed(1)),
    skippedRafsPerSecond: Number(((after.skippedRafs - before.skippedRafs) / seconds).toFixed(1)),
    drawCalls: after.drawCalls,
    triangles: after.triangles,
    rendererCpu: Number(renderer.cpu.percentCPUUsage.toFixed(1)),
    rendererWakeups: renderer.cpu.idleWakeupsPerSecond,
    rendererCore: coreShare(renderer),
    gpuCore: coreShare(gpu),
    browserCore: coreShare(browser),
    gpuCpu: Number(gpu.cpu.percentCPUUsage.toFixed(1)),
    gpuWakeups: gpu.cpu.idleWakeupsPerSecond,
    browserCpu: Number(browser.cpu.percentCPUUsage.toFixed(1)),
    browserWakeups: browser.cpu.idleWakeupsPerSecond,
    energyRenderer: energy[renderer.pid]?.power ?? null,
    energyGpu: energy[gpu.pid]?.power ?? null,
    energyBrowser: energy[browser.pid]?.power ?? null,
    topCpuRenderer: energy[renderer.pid]?.cpu ?? null,
    topCpuGpu: energy[gpu.pid]?.cpu ?? null,
    psCoreRenderer: psShare(renderer.pid),
    psCoreGpu: psShare(gpu.pid),
    gpuUtilisation:
      gpuReadings.length === 0
        ? null
        : Number((gpuReadings.reduce((a, b) => a + b, 0) / gpuReadings.length).toFixed(1)),
    visibility: after.visibility,
    hasFocus: after.hasFocus,
    buffer: after.buffer,
    gpuTimer: after.gpuTimer,
    merged: after.merged,
    heapMB: after.heapMB,
    workingSetMB: Math.round(metrics.reduce((sum, metric) => sum + metric.memory.workingSetSize, 0) / 1024),
  };
  console.log(`RESULT ${JSON.stringify(result)}`);
  cover?.destroy();
  other?.destroy();
  window.destroy();
  app.quit();
});

app.on("quit", () => rmSync(userData, { recursive: true, force: true }));
