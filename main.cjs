const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage, shell, powerMonitor } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pathToFileURL } = require("node:url");
const { spawn, spawnSync } = require("node:child_process");
const net = require("node:net");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();

const DATA_ROOT = path.join(process.env.LOCALAPPDATA || app.getPath("userData"), "DreamWallpaper");
const LIBRARY_DIR = path.join(DATA_ROOT, "library");
const STATE_FILE = path.join(DATA_ROOT, "state.json");
const ENGINE_STATE_FILE = path.join(DATA_ROOT, "engine-state.json");
const ENGINE_STATUS_FILE = path.join(DATA_ROOT, "engine-status.json");
const APP_LOG_FILE = path.join(DATA_ROOT, "app.log");
const APP_PIPE = "\\\\.\\pipe\\DreamWallpaper.Singleton.v1";
const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov", ".m4v"]);

let panelWindow = null;
let showcaseWindow = null;
let tray = null;
let quitting = false;
let engineProcess = null;
let restartTimer = null;
let restartAttempt = 0;
let appPipeServer = null;
let engineExternal = false;
let state = null;
let engineHealthTimer = null;
let engineStartedAt = 0;
let engineStartError = "";
let engineRevision = 0;
let lastRuntimeFingerprint = "";
let rotationTimer = null;
let rotationNextAt = 0;
let screensaverIdleMonitor = null;
let screensaverRotationTimer = null;
let screensaverRotationNextAt = 0;
let screensaverEntryId = null;
let screensaverRearmedAt = Date.now();
let screensaverSuppressUntil = Date.now() + 5000;
let screensaverIdleSeconds = 0;
let workstationLocked = false;
let screensaverPowerEventsRegistered = false;
let lockScreenApplying = false;
let lockScreenQueued = false;
let lockScreenMessage = "";
let lockScreenError = "";
let lockScreenUpdatedAt = 0;

function acquireCrossBuildLock() {
  return new Promise((resolve) => {
    const server = net.createServer((socket) => {
      socket.end();
      setTimeout(() => createPanelWindow(true), 50);
    });
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        const client = net.createConnection(APP_PIPE);
        client.once("connect", () => client.end());
        client.once("error", () => {});
      }
      resolve(false);
    });
    server.listen(APP_PIPE, () => {
      appPipeServer = server;
      resolve(true);
    });
  });
}

function appResource(relative) {
  return app.isPackaged ? path.join(process.resourcesPath, relative) : path.join(__dirname, relative);
}

function engineExecutable() {
  return appResource(path.join("native", "WallpaperEngine.exe"));
}

function lockScreenExecutable() {
  return appResource(path.join("native", "LockScreenHelper.exe"));
}

function errorText(error) {
  return error && error.stack ? error.stack : error && error.message ? error.message : String(error || "未知错误");
}

function logApp(message, error) {
  try {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    if (fs.existsSync(APP_LOG_FILE) && fs.statSync(APP_LOG_FILE).size > 2 * 1024 * 1024) {
      const oldLog = `${APP_LOG_FILE}.old`;
      try { fs.unlinkSync(oldLog); } catch {}
      fs.renameSync(APP_LOG_FILE, oldLog);
    }
    const detail = error ? `\n${errorText(error)}` : "";
    fs.appendFileSync(APP_LOG_FILE, `${new Date().toISOString()} [${process.pid}] ${message}${detail}\n`, "utf8");
  } catch {}
}

function readEngineStatus() {
  try {
    if (!fs.existsSync(ENGINE_STATUS_FILE)) return null;
    const parsed = JSON.parse(fs.readFileSync(ENGINE_STATUS_FILE, "utf8"));
    const updatedAt = Date.parse(parsed.updatedAt || "");
    const ageMs = Number.isFinite(updatedAt) ? Date.now() - updatedAt : Number.POSITIVE_INFINITY;
    return { ...parsed, ageMs, fresh: ageMs >= -5000 && ageMs < 8000 };
  } catch (error) {
    logApp("读取引擎状态失败", error);
    return null;
  }
}

function runtimeState() {
  const helperPresent = fs.existsSync(engineExecutable());
  const processRunning = engineIsRunning();
  const status = readEngineStatus();
  let phase = "starting";
  let engineError = "";
  let wallpaperAttached = false;

  if (!helperPresent) {
    phase = "missing";
    engineError = "壁纸引擎文件缺失，可能被安全软件隔离";
  } else if (status && status.fresh) {
    const activeEntry = state?.library?.find((entry) => entry.id === state.activeId) || null;
    const expectedPath = activeEntry ? path.resolve(LIBRARY_DIR, activeEntry.file).toLowerCase() : "";
    const reportedPath = status.mediaPath ? path.resolve(status.mediaPath).toLowerCase() : "";
    const activeMediaMatches = Boolean(expectedPath && reportedPath && expectedPath === reportedPath);
    wallpaperAttached = Boolean(status.attached && status.mediaLoaded && activeMediaMatches);
    if (wallpaperAttached) phase = "ready";
    else if (!status.attached) {
      phase = "attaching";
      engineError = status.error || "正在等待 Windows Explorer 桌面准备完成";
    } else if (!activeMediaMatches) {
      phase = "starting";
      engineError = "正在加载新选择的壁纸";
    } else {
      phase = "media-error";
      engineError = status.error || "壁纸文件尚未成功加载";
    }
  } else if (processRunning && Date.now() - engineStartedAt < 12000) {
    phase = "starting";
    engineError = "壁纸引擎正在启动";
  } else if (processRunning) {
    phase = "unresponsive";
    engineError = engineStartError || "壁纸引擎没有返回运行状态，正在自动修复";
  } else {
    phase = "stopped";
    engineError = engineStartError || "壁纸引擎未运行";
  }

  return {
    wallpaperAttached,
    helperPresent,
    engineRunning: processRunning,
    phase,
    engineError,
    enginePid: status && status.fresh ? status.pid : null,
    hostKind: status && status.fresh ? status.hostKind || "" : "",
    mediaLoaded: Boolean(status && status.fresh && status.mediaLoaded),
    statusAgeMs: status ? status.ageMs : null,
    logPath: APP_LOG_FILE,
    engineLogPath: path.join(DATA_ROOT, "engine.log"),
  };
}

function terminateStaleEngine() {
  if (process.platform !== "win32") return;
  const taskkill = path.join(process.env.SystemRoot || String.raw`C:\Windows`, "System32", "taskkill.exe");
  try {
    const result = spawnSync(taskkill, ["/F", "/T", "/IM", "WallpaperEngine.exe"], { windowsHide: true, stdio: "ignore", timeout: 5000 });
    logApp(`清理残留壁纸引擎 exit=${result.status}`);
  } catch (error) {
    logApp("清理残留壁纸引擎失败", error);
  }
}

const SCREENSAVER_IDLE_MINUTES = [1, 3, 5, 10, 15, 30];
const SCREENSAVER_ROTATION_MINUTES = [1, 2, 3, 5, 10, 15, 30];

function normalizeChoice(value, allowed, fallback) {
  const numeric = Math.round(Number(value));
  return allowed.includes(numeric) ? numeric : fallback;
}

function normalizeScreensaverIdleMinutes(value) {
  return normalizeChoice(value, SCREENSAVER_IDLE_MINUTES, 5);
}

function normalizeScreensaverRotationMinutes(value) {
  return normalizeChoice(value, SCREENSAVER_ROTATION_MINUTES, 2);
}

function defaultState() {
  return {
    version: 5,
    activeId: null,
    lockScreenAppliedId: null,
    settings: {
      fit: "cover",
      positionX: 50,
      positionY: 50,
      muted: true,
      volume: 0,
      autoStart: true,
      rotationEnabled: false,
      rotationIntervalMinutes: 30,
      rotationMode: "sequential",
      lockScreenSync: false,
      screensaverAutoEnabled: true,
      screensaverIdleMinutes: 5,
      screensaverRotationEnabled: true,
      screensaverRotationIntervalMinutes: 2,
      screensaverRotationMode: "random",
    },
    library: [],
  };
}

async function ensureData() {
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  if (fs.existsSync(STATE_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8").replace(/^\uFEFF/, ""));
      state = { ...defaultState(), ...parsed, settings: { ...defaultState().settings, ...(parsed.settings || {}) } };
      const previousVersion = Number(parsed.version) || 1;
      if (previousVersion < 2) state.settings.autoStart = true;
      state.version = 5;
      state.lockScreenAppliedId = typeof state.lockScreenAppliedId === "string" ? state.lockScreenAppliedId : null;
      state.settings.rotationEnabled = Boolean(state.settings.rotationEnabled);
      state.settings.rotationIntervalMinutes = Math.max(1, Math.min(1440, Math.round(Number(state.settings.rotationIntervalMinutes) || 30)));
      state.settings.rotationMode = state.settings.rotationMode === "random" ? "random" : "sequential";
      state.settings.lockScreenSync = Boolean(state.settings.lockScreenSync);
      state.settings.screensaverAutoEnabled = Boolean(state.settings.screensaverAutoEnabled);
      state.settings.screensaverIdleMinutes = normalizeScreensaverIdleMinutes(state.settings.screensaverIdleMinutes);
      state.settings.screensaverRotationEnabled = Boolean(state.settings.screensaverRotationEnabled);
      state.settings.screensaverRotationIntervalMinutes = normalizeScreensaverRotationMinutes(state.settings.screensaverRotationIntervalMinutes);
      state.settings.screensaverRotationMode = state.settings.screensaverRotationMode === "sequential" ? "sequential" : "random";
    } catch (error) {
      logApp("\u8bfb\u53d6\u72b6\u6001\u6587\u4ef6\u5931\u8d25\uff0c\u5c06\u4ece\u56fe\u5e93\u6587\u4ef6\u81ea\u52a8\u6062\u590d", error);
      try { fs.copyFileSync(STATE_FILE, `${STATE_FILE}.corrupt-${Date.now()}`); } catch {}
      state = defaultState();
    }
  } else {
    state = defaultState();
  }

  removeLegacyDefaultWallpaper();
  state.library = (state.library || []).filter((entry) => entry && entry.file && fs.existsSync(path.join(LIBRARY_DIR, entry.file)));
  recoverOrphanedLibraryFiles();
  await migrateLegacyImages();
  if (!state.library.length) seedDefaultWallpaper();
  if (!state.library.some((entry) => entry.id === state.activeId)) state.activeId = state.library[0]?.id || null;
  saveState();
  writeEngineState();
}

function recoverOrphanedLibraryFiles() {
  const knownFiles = new Set((state.library || []).map((entry) => String(entry.file || "").toLowerCase()));
  const knownIds = new Set((state.library || []).map((entry) => String(entry.id || "")));
  for (const item of fs.readdirSync(LIBRARY_DIR, { withFileTypes: true })) {
    if (!item.isFile() || knownFiles.has(item.name.toLowerCase())) continue;
    const ext = path.extname(item.name).toLowerCase();
    const kind = VIDEO_EXTS.has(ext) ? "video" : IMAGE_EXTS.has(ext) ? "image" : null;
    if (!kind) continue;
    const base = path.basename(item.name, ext);
    let id = base || `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
    while (knownIds.has(id)) id = `${base}-${crypto.randomBytes(2).toString("hex")}`;
    const stat = fs.statSync(path.join(LIBRARY_DIR, item.name));
    state.library.push({
      id,
      name: base === "default-cats" ? "【哲风壁纸】三只猫-偷看-图片" : base,
      file: item.name,
      kind,
      createdAt: Number(stat.birthtimeMs || stat.mtimeMs || Date.now()),
    });
    knownFiles.add(item.name.toLowerCase());
    knownIds.add(id);
    logApp(`\u5df2\u4ece\u56fe\u5e93\u6587\u4ef6\u6062\u590d\u58c1\u7eb8\uff1a${item.name}`);
  }
}

async function convertImageToPngWithChromium(source, destination) {
  const converter = new BrowserWindow({
    show: false,
    width: 8,
    height: 8,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: false },
  });
  try {
    await converter.loadURL("data:text/html;charset=utf-8,<meta charset=utf-8><body></body>");
    const sourceUrl = pathToFileURL(source).href;
    const dataUrl = await converter.webContents.executeJavaScript(`
      new Promise((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          try {
            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context = canvas.getContext("2d");
            context.drawImage(image, 0, 0);
            resolve(canvas.toDataURL("image/png"));
          } catch (error) { reject(new Error(error.message || String(error))); }
        };
        image.onerror = () => reject(new Error("\u5f53\u524d\u7535\u8111\u65e0\u6cd5\u89e3\u7801\u8be5\u56fe\u7247\u683c\u5f0f"));
        image.src = ${JSON.stringify(sourceUrl)};
      })
    `, true);
    const comma = dataUrl.indexOf(",");
    const pngBytes = Buffer.from(comma >= 0 ? dataUrl.slice(comma + 1) : "", "base64");
    if (!pngBytes.length) throw new Error("\u56fe\u7247\u8f6c\u6362\u540e\u4e3a\u7a7a");
    fs.writeFileSync(destination, pngBytes);
    return pngBytes.length;
  } finally {
    if (!converter.isDestroyed()) converter.destroy();
  }
}

async function migrateLegacyImages() {
  let changed = false;
  for (const entry of state.library || []) {
    if (entry.kind !== "image") continue;
    const ext = path.extname(entry.file || "").toLowerCase();
    if (ext !== ".webp" && ext !== ".gif") continue;
    const source = path.join(LIBRARY_DIR, entry.file);
    if (!fs.existsSync(source)) continue;
    try {
      const sourceBytes = fs.readFileSync(source);
      const destinationFile = `${entry.id}.png`;
      const destination = path.join(LIBRARY_DIR, destinationFile);
      const temp = `${destination}.${process.pid}.tmp`;
      const storedSize = await convertImageToPngWithChromium(source, temp);
      fs.renameSync(temp, destination);
      entry.hash = entry.hash || crypto.createHash("sha256").update(sourceBytes).digest("hex");
      entry.size = entry.size || sourceBytes.length;
      entry.storedSize = storedSize;
      entry.file = destinationFile;
      try { fs.unlinkSync(source); } catch {}
      changed = true;
      logApp(`\u5df2\u5c06\u65e7 ${ext} \u58c1\u7eb8\u8f6c\u6362\u4e3a PNG\uff1a${destinationFile}`);
    } catch (error) {
      logApp(`\u65e7\u56fe\u7247\u517c\u5bb9\u8f6c\u6362\u5931\u8d25\uff1a${source}`, error);
    }
  }
  return changed;
}

function removeLegacyDefaultWallpaper() {
  const legacyEntries = (state.library || []).filter((entry) => entry && entry.id === "default-dream");
  if (!legacyEntries.length) return false;
  const removedActive = legacyEntries.some((entry) => entry.id === state.activeId);
  state.library = state.library.filter((entry) => !entry || entry.id !== "default-dream");
  for (const entry of legacyEntries) {
    try { fs.unlinkSync(path.join(LIBRARY_DIR, entry.file)); } catch {}
  }
  if (removedActive) state.activeId = state.library[0]?.id || null;
  logApp(`已移除旧内置默认壁纸 count=${legacyEntries.length}`);
  return true;
}

function seedDefaultWallpaper() {
  const source = appResource(path.join("assets", "default.png"));
  if (!fs.existsSync(source)) return;
  const id = "default-cats";
  const file = `${id}.png`;
  const destination = path.join(LIBRARY_DIR, file);
  if (!fs.existsSync(destination)) fs.copyFileSync(source, destination);
  state.library.push({ id, name: "【哲风壁纸】三只猫-偷看-图片", file, kind: "image", createdAt: Date.now() });
  state.activeId = id;
}

function saveState() {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  const temp = `${STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(state, null, 2), "utf8");
  fs.renameSync(temp, STATE_FILE);
}


function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function libraryContainsHash(targetHash, targetSize) {
  let changed = false;
  let found = false;
  for (const entry of state.library) {
    const filePath = path.join(LIBRARY_DIR, entry.file);
    if (!fs.existsSync(filePath)) continue;
    if (!entry.size) {
      entry.size = fs.statSync(filePath).size;
      changed = true;
    }
    if (entry.size !== targetSize) continue;
    if (!entry.hash) {
      entry.hash = await hashFile(filePath);
      changed = true;
    }
    if (entry.hash === targetHash) {
      found = true;
      break;
    }
  }
  if (changed) saveState();
  return found;
}

function writeEngineState() {
  fs.mkdirSync(DATA_ROOT, { recursive: true });
  const entry = state?.library?.find((item) => item.id === state.activeId) || null;
  const payload = {
    id: entry?.id || "",
    path: entry ? path.join(LIBRARY_DIR, entry.file) : "",
    kind: entry?.kind || "image",
    fit: state?.settings?.fit || "cover",
    positionX: Number(state?.settings?.positionX ?? 50),
    positionY: Number(state?.settings?.positionY ?? 50),
    muted: Boolean(state?.settings?.muted),
    volume: Math.max(0, Math.min(1, Number(state?.settings?.volume) || 0)),
    revision: `${Date.now()}-${process.pid}-${++engineRevision}`,
  };
  const temp = `${ENGINE_STATE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(payload), "utf8");
  fs.renameSync(temp, ENGINE_STATE_FILE);
}

function engineIsRunning() {
  return Boolean(engineProcess && engineProcess.exitCode === null && !engineProcess.killed);
}

function currentScreensaverIdleSeconds() {
  const appIdleSeconds = Math.max(0, Math.floor((Date.now() - screensaverRearmedAt) / 1000));
  let systemIdleSeconds = appIdleSeconds;
  try {
    systemIdleSeconds = Math.max(0, Math.floor(powerMonitor.getSystemIdleTime()));
  } catch {}
  screensaverIdleSeconds = Math.min(systemIdleSeconds, appIdleSeconds);
  return screensaverIdleSeconds;
}

function rearmScreensaver(reason = "unknown", suppressMs = 0) {
  screensaverRearmedAt = Date.now();
  screensaverIdleSeconds = 0;
  screensaverSuppressUntil = Date.now() + Math.max(0, Number(suppressMs) || 0);
  logApp(`重新计算自动屏保等待时间 reason=${reason} suppressMs=${Math.max(0, Number(suppressMs) || 0)}`);
}

function clearScreensaverRotation() {
  clearTimeout(screensaverRotationTimer);
  screensaverRotationTimer = null;
  screensaverRotationNextAt = 0;
}

function scheduleScreensaverRotation() {
  clearScreensaverRotation();
  const running = Boolean(showcaseWindow && !showcaseWindow.isDestroyed());
  if (quitting || !running || !state?.settings?.screensaverRotationEnabled || state.library.length < 2) return;
  const intervalMinutes = normalizeScreensaverRotationMinutes(state.settings.screensaverRotationIntervalMinutes);
  const delay = intervalMinutes * 60 * 1000;
  screensaverRotationNextAt = Date.now() + delay;
  screensaverRotationTimer = setTimeout(() => {
    screensaverRotationTimer = null;
    screensaverRotationNextAt = 0;
    rotateScreensaver("timer");
  }, delay);
  screensaverRotationTimer.unref?.();
  logApp(`已安排屏保轮换 interval=${intervalMinutes}min mode=${state.settings.screensaverRotationMode} nextAt=${new Date(screensaverRotationNextAt).toISOString()}`);
}

function rotateScreensaver(reason = "manual") {
  if (!state || state.library.length < 2 || !showcaseWindow || showcaseWindow.isDestroyed()) {
    scheduleScreensaverRotation();
    return false;
  }
  const currentIndex = state.library.findIndex((entry) => entry.id === screensaverEntryId);
  let nextIndex;
  if (state.settings.screensaverRotationMode === "random") {
    const candidates = state.library.map((_entry, index) => index).filter((index) => index !== currentIndex);
    nextIndex = candidates[Math.floor(Math.random() * candidates.length)];
  } else {
    nextIndex = currentIndex >= 0 ? (currentIndex + 1) % state.library.length : 0;
  }
  const next = state.library[nextIndex];
  if (!next) return false;
  screensaverEntryId = next.id;
  logApp(`屏保轮换完成 reason=${reason} id=${next.id} name=${next.name}`);
  scheduleScreensaverRotation();
  sendState();
  return true;
}

function dynamicShowcasePayload() {
  const activeEntry = state?.library?.find((entry) => entry.id === screensaverEntryId)
    || state?.library?.find((entry) => entry.id === state.activeId)
    || state?.library?.[0]
    || null;
  return {
    entry: activeEntry ? {
      ...activeEntry,
      url: pathToFileURL(path.join(LIBRARY_DIR, activeEntry.file)).href,
    } : null,
    settings: {
      fit: state?.settings?.fit || "cover",
      positionX: Number(state?.settings?.positionX ?? 50),
      positionY: Number(state?.settings?.positionY ?? 50),
      muted: Boolean(state?.settings?.muted),
      volume: Math.max(0, Math.min(1, Number(state?.settings?.volume) || 0)),
    },
  };
}

function startDynamicShowcase(reason = "manual") {
  const alreadyRunning = Boolean(showcaseWindow && !showcaseWindow.isDestroyed());
  if (!alreadyRunning) {
    screensaverEntryId = state?.library?.find((entry) => entry.id === state.activeId)?.id
      || state?.library?.[0]?.id
      || null;
  }
  const payload = dynamicShowcasePayload();
  if (!payload.entry) return false;

  if (alreadyRunning) {
    showcaseWindow.show();
    showcaseWindow.focus();
    showcaseWindow.webContents.send("showcase:state", payload);
    scheduleScreensaverRotation();
    return true;
  }

  showcaseWindow = new BrowserWindow({
    show: false,
    frame: false,
    fullscreen: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    backgroundColor: "#000000",
    title: "Dream Wallpaper · 动态屏保锁定",
    webPreferences: {
      preload: path.join(__dirname, "showcase-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const createdShowcaseWindow = showcaseWindow;
  createdShowcaseWindow.removeMenu();
  createdShowcaseWindow.setAlwaysOnTop(true, "screen-saver");
  try { createdShowcaseWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch {}
  createdShowcaseWindow.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    event.preventDefault();
    if (showcaseWindow !== createdShowcaseWindow || createdShowcaseWindow.isDestroyed()) return;
    closeDynamicShowcase("keyboard-input", true);
  });
  createdShowcaseWindow.loadFile(path.join(__dirname, "ui", "showcase.html"));
  createdShowcaseWindow.once("ready-to-show", () => {
    if (showcaseWindow !== createdShowcaseWindow || createdShowcaseWindow.isDestroyed()) return;
    createdShowcaseWindow.show();
    createdShowcaseWindow.focus();
    createdShowcaseWindow.webContents.send("showcase:state", dynamicShowcasePayload());
  });
  createdShowcaseWindow.on("closed", () => {
    if (showcaseWindow === createdShowcaseWindow) {
      showcaseWindow = null;
      clearScreensaverRotation();
      screensaverEntryId = null;
      if (!workstationLocked && !quitting) rearmScreensaver("showcase-window-closed", 3000);
    }
    sendState();
  });
  scheduleScreensaverRotation();
  logApp(`启动动态屏保锁定 reason=${reason} media=${payload.entry.file}`);
  sendState();
  return true;
}

function lockWorkstation(reason = "user-input") {
  if (process.platform !== "win32") {
    logApp(`无法锁定工作站：当前平台不是 Windows reason=${reason}`);
    return false;
  }
  const systemRoot = process.env.SystemRoot || String.raw`C:\Windows`;
  const systemRundll32 = path.join(systemRoot, "System32", "rundll32.exe");
  const executable = fs.existsSync(systemRundll32) ? systemRundll32 : "rundll32.exe";
  try {
    const child = spawn(executable, ["user32.dll,LockWorkStation"], {
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", (error) => logApp(`锁定工作站启动失败 reason=${reason} error=${error.message}`));
    child.unref();
    logApp(`已请求 Windows 锁定工作站 reason=${reason}`);
    return true;
  } catch (error) {
    logApp(`锁定工作站失败 reason=${reason} error=${error.message}`);
    return false;
  }
}

function closeDynamicShowcase(reason = "unknown", lockAfter = false) {
  if (!showcaseWindow || showcaseWindow.isDestroyed()) {
    showcaseWindow = null;
    clearScreensaverRotation();
    screensaverEntryId = null;
    return false;
  }
  const target = showcaseWindow;
  showcaseWindow = null;
  clearScreensaverRotation();
  screensaverEntryId = null;
  if (lockAfter) screensaverSuppressUntil = Date.now() + 15000;
  else if (!quitting && !workstationLocked) rearmScreensaver(`showcase-close-${reason}`, 3000);
  logApp(`退出动态屏保 reason=${reason} lockAfter=${lockAfter}`);
  try { target.destroy(); } catch {}
  sendState();
  if (lockAfter) {
    const lockTimer = setTimeout(() => lockWorkstation(reason), 120);
    if (typeof lockTimer.unref === "function") lockTimer.unref();
  }
  return true;
}

function startScreensaverIdleMonitor() {
  clearInterval(screensaverIdleMonitor);
  screensaverIdleMonitor = setInterval(() => {
    if (quitting || workstationLocked || !state?.settings?.screensaverAutoEnabled) return;
    if (showcaseWindow && !showcaseWindow.isDestroyed()) return;
    if (!state.library.length || Date.now() < screensaverSuppressUntil) return;
    const idleSeconds = currentScreensaverIdleSeconds();
    const targetSeconds = normalizeScreensaverIdleMinutes(state.settings.screensaverIdleMinutes) * 60;
    if (idleSeconds >= targetSeconds) startDynamicShowcase("system-idle");
  }, 1000);
  screensaverIdleMonitor.unref?.();
}

function stopScreensaverIdleMonitor() {
  clearInterval(screensaverIdleMonitor);
  screensaverIdleMonitor = null;
}

function registerScreensaverPowerEvents() {
  if (screensaverPowerEventsRegistered) return;
  screensaverPowerEventsRegistered = true;
  powerMonitor.on("lock-screen", () => {
    workstationLocked = true;
    screensaverSuppressUntil = Date.now() + 60000;
    if (showcaseWindow && !showcaseWindow.isDestroyed()) closeDynamicShowcase("windows-lock", false);
    logApp("检测到 Windows 已锁定");
  });
  powerMonitor.on("unlock-screen", () => {
    workstationLocked = false;
    rearmScreensaver("windows-unlock", 5000);
    sendState();
    logApp("检测到 Windows 已解锁，自动屏保重新计时");
  });
  powerMonitor.on("suspend", () => {
    if (showcaseWindow && !showcaseWindow.isDestroyed()) closeDynamicShowcase("system-suspend", false);
    screensaverSuppressUntil = Date.now() + 60000;
    logApp("检测到系统休眠");
  });
  powerMonitor.on("resume", () => {
    workstationLocked = false;
    rearmScreensaver("system-resume", 5000);
    sendState();
    logApp("检测到系统恢复，自动屏保重新计时");
  });
}

function publicState() {
  const activeEntry = state.library.find((entry) => entry.id === state.activeId) || null;
  const showcaseEntry = state.library.find((entry) => entry.id === screensaverEntryId) || activeEntry || state.library[0] || null;
  const lockHelperPresent = process.platform === "win32" && fs.existsSync(lockScreenExecutable());
  return {
    activeId: state.activeId,
    settings: { ...state.settings },
    library: state.library.map((entry) => ({
      ...entry,
      url: pathToFileURL(path.join(LIBRARY_DIR, entry.file)).href,
      active: entry.id === state.activeId,
    })),
    runtime: runtimeState(),
    rotation: {
      enabled: Boolean(state.settings.rotationEnabled),
      canRotate: state.library.length > 1,
      nextAt: rotationNextAt || null,
    },
    lockScreen: {
      supported: lockHelperPresent,
      enabled: Boolean(state.settings.lockScreenSync),
      applying: lockScreenApplying,
      canApply: Boolean(activeEntry && activeEntry.kind === "image"),
      activeKind: activeEntry?.kind || null,
      activeId: activeEntry?.id || null,
      lastAppliedId: state.lockScreenAppliedId || null,
      message: lockScreenMessage,
      error: lockScreenError,
      updatedAt: lockScreenUpdatedAt || null,
    },
    showcase: {
      running: Boolean(showcaseWindow && !showcaseWindow.isDestroyed()),
      canStart: Boolean(showcaseEntry),
      activeId: showcaseEntry?.id || null,
      activeKind: showcaseEntry?.kind || null,
      idleSeconds: currentScreensaverIdleSeconds(),
      idleTargetSeconds: normalizeScreensaverIdleMinutes(state.settings.screensaverIdleMinutes) * 60,
      rotationNextAt: screensaverRotationNextAt || null,
      workstationLocked,
    },
  };
}

function sendState() {
  const snapshot = publicState();
  if (panelWindow && !panelWindow.isDestroyed() && !panelWindow.webContents.isDestroyed()) {
    panelWindow.webContents.send("wallpaper:state", snapshot);
  }
  if (showcaseWindow && !showcaseWindow.isDestroyed() && !showcaseWindow.webContents.isDestroyed()) {
    showcaseWindow.webContents.send("showcase:state", dynamicShowcasePayload());
  }
  rebuildTrayMenu();
}

function runLockScreenHelper(imagePath) {
  return new Promise((resolve) => {
    const executable = lockScreenExecutable();
    if (process.platform !== "win32") {
      resolve({ ok: false, code: "unsupported-platform", message: "锁屏壁纸仅支持 Windows。" });
      return;
    }
    if (!fs.existsSync(executable)) {
      resolve({ ok: false, code: "helper-missing", message: "锁屏组件缺失，可能被安全软件隔离。" });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    let child;
    try {
      child = spawn(executable, [imagePath], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish({ ok: false, code: "launch-failed", message: `无法启动锁屏组件：${error.message || error}` });
      return;
    }

    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ ok: false, code: "timeout", message: "设置锁屏超时，请稍后重试。" });
    }, 20000);
    timer.unref?.();

    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", (error) => finish({ ok: false, code: "launch-failed", message: `无法启动锁屏组件：${error.message || error}` }));
    child.once("close", (code) => {
      let parsed = null;
      const lines = stdout.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length) {
        try { parsed = JSON.parse(lines[lines.length - 1]); } catch {}
      }
      if (parsed && typeof parsed.ok === "boolean") {
        finish(parsed);
        return;
      }
      finish({
        ok: code === 0,
        code: code === 0 ? "applied" : "helper-failed",
        message: (stderr || stdout || `锁屏组件退出代码 ${code}`).trim(),
      });
    });
  });
}

async function applyLockScreenForActive(reason = "manual") {
  const entry = state?.library?.find((item) => item.id === state.activeId) || null;
  if (!entry) {
    lockScreenError = "图库中没有可用于锁屏的图片。";
    lockScreenMessage = "";
    lockScreenUpdatedAt = Date.now();
    sendState();
    return { ok: false, code: "no-wallpaper", message: lockScreenError };
  }
  if (entry.kind !== "image") {
    lockScreenError = "";
    lockScreenMessage = "Windows 锁屏只支持静态图片；当前是视频，锁屏会保留上一张图片。";
    lockScreenUpdatedAt = Date.now();
    logApp(`跳过锁屏同步 reason=${reason} id=${entry.id} kind=${entry.kind}`);
    sendState();
    return { ok: false, code: "video-unsupported", message: lockScreenMessage };
  }
  if (lockScreenApplying) {
    lockScreenQueued = true;
    return { ok: false, code: "queued", message: "锁屏更新已排队。" };
  }

  lockScreenApplying = true;
  lockScreenError = "";
  lockScreenMessage = "正在更新 Windows 锁屏…";
  sendState();
  const imagePath = path.join(LIBRARY_DIR, entry.file);
  let result;
  try {
    result = await runLockScreenHelper(imagePath);
    lockScreenUpdatedAt = Date.now();
    if (result.ok) {
      state.lockScreenAppliedId = entry.id;
      lockScreenError = "";
      lockScreenMessage = "锁屏壁纸已更新。";
      saveState();
      logApp(`锁屏壁纸更新完成 reason=${reason} id=${entry.id} name=${entry.name}`);
    } else {
      lockScreenError = result.message || "锁屏壁纸更新失败。";
      lockScreenMessage = "";
      logApp(`锁屏壁纸更新失败 reason=${reason} id=${entry.id} code=${result.code || "unknown"}`, new Error(lockScreenError));
    }
  } catch (error) {
    result = { ok: false, code: "exception", message: error.message || String(error) };
    lockScreenUpdatedAt = Date.now();
    lockScreenError = result.message;
    lockScreenMessage = "";
    logApp(`锁屏壁纸更新异常 reason=${reason} id=${entry.id}`, error);
  } finally {
    lockScreenApplying = false;
    sendState();
    if (lockScreenQueued) {
      lockScreenQueued = false;
      setTimeout(() => applyLockScreenForActive("queued"), 0);
    }
  }
  return result;
}

function syncLockScreenIfEnabled(reason) {
  if (!state?.settings?.lockScreenSync) return;
  void applyLockScreenForActive(reason);
}

function clearWallpaperRotation() {
  clearTimeout(rotationTimer);
  rotationTimer = null;
  rotationNextAt = 0;
}

function scheduleWallpaperRotation() {
  clearWallpaperRotation();
  if (quitting || !state?.settings?.rotationEnabled || state.library.length < 2) return;
  const intervalMinutes = Math.max(1, Math.min(1440, Math.round(Number(state.settings.rotationIntervalMinutes) || 30)));
  const delay = intervalMinutes * 60 * 1000;
  rotationNextAt = Date.now() + delay;
  rotationTimer = setTimeout(() => {
    rotationTimer = null;
    rotationNextAt = 0;
    rotateWallpaper("timer");
  }, delay);
  rotationTimer.unref?.();
  logApp(`已安排定时轮换 interval=${intervalMinutes}min mode=${state.settings.rotationMode} nextAt=${new Date(rotationNextAt).toISOString()}`);
}

function rotateWallpaper(reason = "manual") {
  if (!state || state.library.length < 2) {
    scheduleWallpaperRotation();
    sendState();
    return false;
  }

  const currentIndex = state.library.findIndex((entry) => entry.id === state.activeId);
  let nextIndex;
  if (state.settings.rotationMode === "random") {
    const candidates = state.library.map((_entry, index) => index).filter((index) => index !== currentIndex);
    nextIndex = candidates[Math.floor(Math.random() * candidates.length)];
  } else {
    nextIndex = currentIndex >= 0 ? (currentIndex + 1) % state.library.length : 0;
  }

  const next = state.library[nextIndex];
  if (!next) return false;
  state.activeId = next.id;
  saveState();
  writeEngineState();
  startEngine();
  scheduleWallpaperRotation();
  syncLockScreenIfEnabled(`rotation-${reason}`);
  logApp(`壁纸轮换完成 reason=${reason} id=${next.id} name=${next.name}`);
  sendState();
  return true;
}

function scheduleEngineRestart(delayOverride) {
  if (quitting || restartTimer) return;
  const delay = Number.isFinite(delayOverride)
    ? Math.max(0, delayOverride)
    : Math.min(30000, 1200 * (2 ** Math.min(restartAttempt, 5)));
  restartAttempt += 1;
  logApp(`计划在 ${delay}ms 后重启壁纸引擎（第 ${restartAttempt} 次）`);
  restartTimer = setTimeout(() => {
    restartTimer = null;
    startEngine();
  }, delay);
  restartTimer.unref?.();
}

function startEngine() {
  writeEngineState();
  if (engineIsRunning()) return true;

  const executable = engineExecutable();
  if (!fs.existsSync(executable)) {
    engineStartError = "壁纸引擎文件缺失，可能被安全软件隔离";
    logApp(engineStartError);
    sendState();
    return false;
  }

  try {
    engineExternal = false;
    try { fs.unlinkSync(ENGINE_STATUS_FILE); } catch {}
    engineStartedAt = Date.now();
    engineStartError = "";
    logApp(`启动壁纸引擎：${executable}`);
    const child = spawn(executable, ["--state", ENGINE_STATE_FILE, "--status", ENGINE_STATUS_FILE], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    engineProcess = child;
    child.once("spawn", () => {
      logApp(`壁纸引擎已创建 pid=${child.pid}`);
      sendState();
    });
    child.once("error", (error) => {
      if (engineProcess === child) engineProcess = null;
      engineStartError = `无法启动壁纸引擎：${error.message || error}`;
      logApp(engineStartError, error);
      sendState();
      scheduleEngineRestart();
    });
    child.once("exit", (code, signal) => {
      if (engineProcess === child) engineProcess = null;
      engineStartError = code === 10
        ? "检测到残留的旧壁纸引擎，正在自动清理并重启"
        : `壁纸引擎已退出（代码 ${code ?? "未知"}${signal ? `，信号 ${signal}` : ""}）`;
      logApp(engineStartError);
      if (code === 10) terminateStaleEngine();
      sendState();
      scheduleEngineRestart();
    });
    return true;
  } catch (error) {
    engineProcess = null;
    engineStartError = `启动壁纸引擎异常：${error.message || error}`;
    logApp(engineStartError, error);
    sendState();
    scheduleEngineRestart();
    return false;
  }
}

function monitorEngineHealth() {
  if (quitting) return;
  const status = readEngineStatus();
  if (engineIsRunning() && status && status.fresh) restartAttempt = 0;
  if (!engineIsRunning()) {
    scheduleEngineRestart();
  } else if (Date.now() - engineStartedAt > 15000 && (!status || !status.fresh)) {
    engineStartError = "壁纸引擎长时间没有响应，正在自动重启";
    logApp(engineStartError);
    try { engineProcess.kill(); } catch {}
    engineProcess = null;
    scheduleEngineRestart();
  }
  const fingerprint = JSON.stringify(runtimeState());
  if (fingerprint !== lastRuntimeFingerprint) {
    lastRuntimeFingerprint = fingerprint;
    sendState();
  }
}

function startEngineHealthMonitor() {
  clearInterval(engineHealthTimer);
  engineHealthTimer = setInterval(monitorEngineHealth, 2000);
  engineHealthTimer.unref?.();
}

function restartEngine() {
  restartAttempt = 0;
  engineExternal = false;
  engineStartError = "正在手动重启壁纸引擎";
  logApp(engineStartError);
  writeEngineState();
  if (engineIsRunning()) {
    try { engineProcess.kill(); } catch {}
    scheduleEngineRestart();
  } else {
    startEngine();
  }
  setTimeout(sendState, 400).unref?.();
}

function stopEngine() {
  clearInterval(engineHealthTimer);
  engineHealthTimer = null;
  clearTimeout(restartTimer);
  restartTimer = null;
  if (engineIsRunning()) {
    try { engineProcess.kill(); } catch {}
  }
  engineProcess = null;
  engineExternal = false;
}

function createPanelWindow(show = true) {
  if (panelWindow && !panelWindow.isDestroyed()) {
    if (show) {
      panelWindow.show();
      panelWindow.focus();
    }
    return panelWindow;
  }

  panelWindow = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 920,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: "#0c1018",
    title: "Dream Wallpaper",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  panelWindow.removeMenu();
  panelWindow.loadFile(path.join(__dirname, "ui", "index.html"));
  panelWindow.once("ready-to-show", () => { if (show) panelWindow.show(); });
  panelWindow.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      panelWindow.hide();
    }
  });
  panelWindow.on("closed", () => { panelWindow = null; });
  return panelWindow;
}

function trayIcon() {
  const iconPath = appResource(path.join("assets", "tray.png"));
  if (fs.existsSync(iconPath)) return nativeImage.createFromPath(iconPath);
  return nativeImage.createEmpty();
}

function rebuildTrayMenu() {
  if (!tray || !state) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "打开 Dream Wallpaper", click: () => createPanelWindow(true) },
    { label: "重新启动壁纸引擎", click: () => restartEngine() },
    { label: "立即换一张", enabled: state.library.length > 1, click: () => rotateWallpaper("tray") },
    {
      label: showcaseWindow && !showcaseWindow.isDestroyed()
        ? "退出屏保并锁定 Windows"
        : "立即进入动态屏保",
      enabled: Boolean(state.library.some((entry) => entry.id === state.activeId)),
      click: () => {
        if (showcaseWindow && !showcaseWindow.isDestroyed()) closeDynamicShowcase("tray", true);
        else startDynamicShowcase();
      },
    },
    { type: "separator" },
    {
      label: "定时轮换",
      type: "checkbox",
      checked: Boolean(state.settings.rotationEnabled),
      click: (item) => updateSettings({ rotationEnabled: item.checked }),
    },
    {
      label: "自动动态屏保",
      type: "checkbox",
      checked: Boolean(state.settings.screensaverAutoEnabled),
      click: (item) => { void updateSettings({ screensaverAutoEnabled: item.checked }); },
    },
    {
      label: "锁屏跟随桌面",
      type: "checkbox",
      checked: Boolean(state.settings.lockScreenSync),
      click: (item) => { void updateSettings({ lockScreenSync: item.checked }); },
    },
    {
      label: "将当前图片设为锁屏",
      enabled: !lockScreenApplying && state.library.some((entry) => entry.id === state.activeId && entry.kind === "image"),
      click: () => { void applyLockScreenForActive("tray"); },
    },
    { type: "separator" },
    {
      label: "开机自动启动",
      type: "checkbox",
      checked: Boolean(state.settings.autoStart),
      click: (item) => updateSettings({ autoStart: item.checked }),
    },
    { type: "separator" },
    { label: "退出", click: () => { quitting = true; app.quit(); } },
  ]));
}

function createTray() {
  if (tray) return;
  tray = new Tray(trayIcon());
  tray.setToolTip("Dream Wallpaper");
  tray.on("double-click", () => createPanelWindow(true));
  rebuildTrayMenu();
}

function applyAutoStart(enabled) {
  const packagedExecutable = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;

  if (process.platform === "win32" && app.isPackaged) {
    const regExe = path.join(process.env.SystemRoot || String.raw`C:\Windows`, "System32", "reg.exe");
    const runKey = String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`;
    const valueName = "com.dreamwallpaper.desktop";
    const command = `"${packagedExecutable}" --background`;
    const args = enabled
      ? ["ADD", runKey, "/v", valueName, "/t", "REG_SZ", "/d", command, "/f"]
      : ["DELETE", runKey, "/v", valueName, "/f"];

    try {
      const result = spawnSync(regExe, args, { windowsHide: true, encoding: "utf8" });
      const expectedStatus = enabled ? result.status === 0 : [0, 1].includes(result.status);
      if (!expectedStatus || result.error) {
        throw result.error || new Error((result.stderr || result.stdout || `reg.exe exit ${result.status}`).trim());
      }

      const verification = spawnSync(regExe, ["QUERY", runKey, "/v", valueName], {
        windowsHide: true,
        encoding: "utf8",
      });
      const registered = verification.status === 0
        && verification.stdout.includes(packagedExecutable)
        && verification.stdout.includes("--background");
      if (enabled !== registered) throw new Error("开机自启动注册表校验未通过");
      logApp(`开机自启动${enabled ? "已启用" : "已关闭"} executable=${packagedExecutable}`);
    } catch (error) {
      logApp(`设置开机自启动失败 enabled=${enabled} executable=${packagedExecutable}`, error);
    }
    return;
  }

  const options = app.isPackaged
    ? { openAtLogin: enabled, path: packagedExecutable, args: ["--background"] }
    : { openAtLogin: enabled, path: process.execPath, args: [app.getAppPath(), "--background"] };
  try {
    app.setLoginItemSettings(options);
  } catch (error) {
    logApp(`设置开机自启动失败 enabled=${enabled}`, error);
  }
}

async function updateSettings(patch) {
  const rotationChanged = ["rotationEnabled", "rotationIntervalMinutes", "rotationMode"]
    .some((key) => Object.prototype.hasOwnProperty.call(patch, key));
  const screensaverChanged = [
    "screensaverAutoEnabled",
    "screensaverIdleMinutes",
    "screensaverRotationEnabled",
    "screensaverRotationIntervalMinutes",
    "screensaverRotationMode",
  ].some((key) => Object.prototype.hasOwnProperty.call(patch, key));
  const screensaverWaitChanged = ["screensaverAutoEnabled", "screensaverIdleMinutes"]
    .some((key) => Object.prototype.hasOwnProperty.call(patch, key));
  const lockScreenChanged = Object.prototype.hasOwnProperty.call(patch, "lockScreenSync");
  state.settings = { ...state.settings, ...patch };
  state.settings.rotationEnabled = Boolean(state.settings.rotationEnabled);
  state.settings.rotationIntervalMinutes = Math.max(1, Math.min(1440, Math.round(Number(state.settings.rotationIntervalMinutes) || 30)));
  state.settings.rotationMode = state.settings.rotationMode === "random" ? "random" : "sequential";
  state.settings.lockScreenSync = Boolean(state.settings.lockScreenSync);
  state.settings.screensaverAutoEnabled = Boolean(state.settings.screensaverAutoEnabled);
  state.settings.screensaverIdleMinutes = normalizeScreensaverIdleMinutes(state.settings.screensaverIdleMinutes);
  state.settings.screensaverRotationEnabled = Boolean(state.settings.screensaverRotationEnabled);
  state.settings.screensaverRotationIntervalMinutes = normalizeScreensaverRotationMinutes(state.settings.screensaverRotationIntervalMinutes);
  state.settings.screensaverRotationMode = state.settings.screensaverRotationMode === "sequential" ? "sequential" : "random";
  if (Object.prototype.hasOwnProperty.call(patch, "autoStart")) applyAutoStart(Boolean(state.settings.autoStart));
  if (lockScreenChanged && !state.settings.lockScreenSync) {
    lockScreenError = "";
    lockScreenMessage = "已停止跟随桌面；当前 Windows 锁屏不会被清除。";
    lockScreenUpdatedAt = Date.now();
  }
  if (screensaverWaitChanged) rearmScreensaver("settings-updated", 1500);
  saveState();
  writeEngineState();
  startEngine();
  if (rotationChanged) scheduleWallpaperRotation();
  if (screensaverChanged) scheduleScreensaverRotation();
  sendState();
  if (lockScreenChanged && state.settings.lockScreenSync) await applyLockScreenForActive("settings-enabled");
  return publicState();
}

async function importMedia() {
  const result = await dialog.showOpenDialog(panelWindow || undefined, {
    title: "选择图片或视频壁纸",
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "图片和视频", extensions: ["jpg", "jpeg", "png", "webp", "bmp", "gif", "mp4", "webm", "mov", "m4v"] },
      { name: "所有文件", extensions: ["*"] },
    ],
  });
  if (result.canceled || !result.filePaths.length) {
    return { ...publicState(), operation: { imported: 0, duplicates: 0, unsupported: 0, failed: 0, errors: [], canceled: true } };
  }

  let newest = null;
  let imported = 0;
  let duplicates = 0;
  let unsupported = 0;
  let failed = 0;
  const errors = [];
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });

  for (const source of result.filePaths) {
    try {
      const ext = path.extname(source).toLowerCase();
      const kind = VIDEO_EXTS.has(ext) ? "video" : IMAGE_EXTS.has(ext) ? "image" : null;
      if (!kind) {
        unsupported += 1;
        continue;
      }
      const sourceStat = fs.statSync(source);
      if (!sourceStat.isFile() || sourceStat.size <= 0) throw new Error("文件为空或不是普通文件");
      const hash = await hashFile(source);
      if (await libraryContainsHash(hash, sourceStat.size)) {
        duplicates += 1;
        continue;
      }

      const id = `${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
      const convertToPng = kind === "image" && (ext === ".webp" || ext === ".gif");
      const storedExt = convertToPng ? ".png" : ext;
      const file = `${id}${storedExt}`;
      const destination = path.join(LIBRARY_DIR, file);
      let storedSize;
      if (convertToPng) {
        storedSize = await convertImageToPngWithChromium(source, destination);
      } else {
        fs.copyFileSync(source, destination);
        storedSize = fs.statSync(destination).size;
      }
      newest = { id, name: path.basename(source, ext), file, kind, hash, size: sourceStat.size, storedSize, createdAt: Date.now() };
      state.library.unshift(newest);
      imported += 1;
      logApp(`导入成功 source=${source} destination=${destination} kind=${kind} size=${sourceStat.size}`);
    } catch (error) {
      failed += 1;
      const message = `${path.basename(source)}：${error.message || error}`;
      errors.push(message);
      logApp(`导入失败 source=${source}`, error);
    }
  }

  if (newest) state.activeId = newest.id;
  saveState();
  writeEngineState();
  if (newest) {
    startEngine();
    scheduleWallpaperRotation();
    scheduleScreensaverRotation();
    syncLockScreenIfEnabled("import");
  }
  sendState();
  return { ...publicState(), operation: { imported, duplicates, unsupported, failed, errors: errors.slice(0, 5), canceled: false } };
}

function registerIpc() {
  ipcMain.handle("wallpaper:get-state", () => publicState());
  ipcMain.handle("wallpaper:import", () => importMedia());
  ipcMain.handle("wallpaper:apply", (_event, id) => {
    if (state.library.some((entry) => entry.id === id)) state.activeId = id;
    saveState();
    writeEngineState();
    startEngine();
    scheduleWallpaperRotation();
    syncLockScreenIfEnabled("apply");
    sendState();
    return publicState();
  });
  ipcMain.handle("wallpaper:remove", (_event, id) => {
    const index = state.library.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      const [removed] = state.library.splice(index, 1);
      try { fs.unlinkSync(path.join(LIBRARY_DIR, removed.file)); } catch {}
      if (state.activeId === id) state.activeId = state.library[0]?.id || null;
      if (!state.library.length) seedDefaultWallpaper();
      saveState();
      writeEngineState();
      startEngine();
      scheduleWallpaperRotation();
      scheduleScreensaverRotation();
      syncLockScreenIfEnabled("remove-active");
      sendState();
    }
    return publicState();
  });
  ipcMain.handle("wallpaper:remove-many", (_event, ids) => {
    const requested = new Set(Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : []);
    const includedActive = requested.delete(state.activeId);
    const removed = [];
    state.library = state.library.filter((entry) => {
      if (!requested.has(entry.id)) return true;
      removed.push(entry);
      return false;
    });
    for (const entry of removed) {
      try { fs.unlinkSync(path.join(LIBRARY_DIR, entry.file)); } catch {}
    }
    if (!state.library.length) seedDefaultWallpaper();
    if (removed.length) {
      saveState();
      writeEngineState();
      scheduleWallpaperRotation();
      scheduleScreensaverRotation();
      sendState();
    }
    return { ...publicState(), operation: { removed: removed.length, protected: includedActive ? 1 : 0 } };
  });
  ipcMain.handle("wallpaper:update-settings", (_event, patch) => updateSettings(patch || {}));
  ipcMain.handle("wallpaper:rotate-now", () => {
    const rotated = rotateWallpaper("panel");
    return { ...publicState(), operation: { rotated } };
  });
  ipcMain.handle("wallpaper:apply-lock-screen", async () => {
    const result = await applyLockScreenForActive("panel");
    return { ...publicState(), operation: { lockScreen: result } };
  });
  ipcMain.handle("wallpaper:toggle-showcase", () => {
    const running = Boolean(showcaseWindow && !showcaseWindow.isDestroyed());
    const changed = running ? closeDynamicShowcase("panel", true) : startDynamicShowcase();
    return { ...publicState(), operation: { showcase: { changed, running: !running && changed } } };
  });
  ipcMain.on("showcase:ready", (event) => {
    if (!showcaseWindow || showcaseWindow.isDestroyed() || event.sender !== showcaseWindow.webContents) return;
    showcaseWindow.webContents.send("showcase:state", dynamicShowcasePayload());
  });
  ipcMain.on("showcase:exit-and-lock", (event) => {
    if (!showcaseWindow || showcaseWindow.isDestroyed() || event.sender !== showcaseWindow.webContents) return;
    closeDynamicShowcase("pointer-input", true);
  });
  ipcMain.handle("wallpaper:restart-engine", () => { restartEngine(); return publicState(); });
  ipcMain.handle("wallpaper:open-logs", () => {
    fs.mkdirSync(DATA_ROOT, { recursive: true });
    if (!fs.existsSync(APP_LOG_FILE)) fs.writeFileSync(APP_LOG_FILE, "", "utf8");
    shell.showItemInFolder(APP_LOG_FILE);
    return APP_LOG_FILE;
  });
  ipcMain.handle("wallpaper:show-panel", () => { createPanelWindow(true); return true; });
  ipcMain.handle("wallpaper:quit", () => { quitting = true; app.quit(); return true; });
}

app.on("second-instance", () => createPanelWindow(true));
app.on("before-quit", () => {
  quitting = true;
  if (appPipeServer) appPipeServer.close();
  clearInterval(engineHealthTimer);
  clearWallpaperRotation();
  stopScreensaverIdleMonitor();
  clearScreensaverRotation();
  closeDynamicShowcase("app-quit", false);
  stopEngine();
});
app.on("window-all-closed", () => {});

app.whenReady().then(async () => {
  if (!(await acquireCrossBuildLock())) {
    quitting = true;
    app.quit();
    return;
  }
  app.setAppUserModelId("com.dreamwallpaper.desktop");
  await ensureData();
  registerIpc();
  terminateStaleEngine();
  startEngine();
  startEngineHealthMonitor();
  createTray();
  registerScreensaverPowerEvents();
  rearmScreensaver("app-ready", 5000);
  startScreensaverIdleMonitor();
  scheduleWallpaperRotation();
  syncLockScreenIfEnabled("startup");
  createPanelWindow(!process.argv.includes("--background"));
  applyAutoStart(Boolean(state.settings.autoStart));
});



