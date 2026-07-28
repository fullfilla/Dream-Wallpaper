const api = window.dreamWallpaper;
const elements = {
  grid: document.getElementById("wallpaperGrid"),
  empty: document.getElementById("emptyState"),
  count: document.getElementById("libraryCount"),
  importButton: document.getElementById("importButton"),
  emptyImportButton: document.getElementById("emptyImportButton"),
  batchModeButton: document.getElementById("batchModeButton"),
  batchToolbar: document.getElementById("batchToolbar"),
  selectedCount: document.getElementById("selectedCount"),
  selectAllButton: document.getElementById("selectAllButton"),
  clearSelectionButton: document.getElementById("clearSelectionButton"),
  removeSelectedButton: document.getElementById("removeSelectedButton"),
  finishBatchButton: document.getElementById("finishBatchButton"),
  statusDot: document.getElementById("statusDot"),
  statusText: document.getElementById("statusText"),
  statusDetail: document.getElementById("statusDetail"),
  restartEngineButton: document.getElementById("restartEngineButton"),
  openLogsButton: document.getElementById("openLogsButton"),
  autoStart: document.getElementById("autoStart"),
  rotationEnabled: document.getElementById("rotationEnabled"),
  rotationInterval: document.getElementById("rotationInterval"),
  rotationMode: document.getElementById("rotationMode"),
  rotateNowButton: document.getElementById("rotateNowButton"),
  rotationStatus: document.getElementById("rotationStatus"),
  lockScreenSync: document.getElementById("lockScreenSync"),
  applyLockScreenButton: document.getElementById("applyLockScreenButton"),
  lockScreenStatus: document.getElementById("lockScreenStatus"),
  toggleShowcaseButton: document.getElementById("toggleShowcaseButton"),
  showcaseStatus: document.getElementById("showcaseStatus"),
  screensaverAutoEnabled: document.getElementById("screensaverAutoEnabled"),
  screensaverIdleMinutes: document.getElementById("screensaverIdleMinutes"),
  screensaverRotationEnabled: document.getElementById("screensaverRotationEnabled"),
  screensaverRotationInterval: document.getElementById("screensaverRotationInterval"),
  screensaverRotationMode: document.getElementById("screensaverRotationMode"),
  fit: document.getElementById("fitSelect"),
  muted: document.getElementById("muted"),
  volume: document.getElementById("volume"),
  volumeValue: document.getElementById("volumeValue"),
  positionX: document.getElementById("positionX"),
  positionY: document.getElementById("positionY"),
  positionXValue: document.getElementById("positionXValue"),
  positionYValue: document.getElementById("positionYValue"),
  toast: document.getElementById("toast"),
};

let currentState = null;
let toastTimer = null;
let saveTimer = null;
let batchMode = false;
const selectedIds = new Set();

function showToast(message, isError = false) {
  elements.toast.textContent = message;
  elements.toast.classList.toggle("error", Boolean(isError));
  elements.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => elements.toast.classList.remove("show"), isError ? 6500 : 3200);
}

function formatDate(timestamp) {
  return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric" }).format(new Date(timestamp));
}

function setSelected(id, selected) {
  const entry = currentState?.library.find((item) => item.id === id);
  if (!entry || entry.active) return;
  if (selected) selectedIds.add(id);
  else selectedIds.delete(id);
  render(currentState);
}

function createCard(entry) {
  const selected = selectedIds.has(entry.id);
  const card = document.createElement("article");
  card.className = `wallpaper-card${entry.active ? " active" : ""}${batchMode ? " batch-mode" : ""}${selected ? " selected" : ""}`;

  const preview = document.createElement("div");
  preview.className = "preview";
  const media = document.createElement(entry.kind === "video" ? "video" : "img");
  media.src = entry.url;
  media.alt = entry.name;
  if (entry.kind === "video") {
    media.muted = true;
    media.loop = true;
    media.preload = "metadata";
    preview.addEventListener("mouseenter", () => media.play().catch(() => {}));
    preview.addEventListener("mouseleave", () => { media.pause(); media.currentTime = 0; });
  }
  preview.appendChild(media);

  const typeBadge = document.createElement("span");
  typeBadge.className = "type-badge";
  typeBadge.textContent = entry.kind === "video" ? "VIDEO" : "IMAGE";
  preview.appendChild(typeBadge);
  if (entry.active) {
    const active = document.createElement("span");
    active.className = "active-badge";
    active.textContent = "正在使用";
    preview.appendChild(active);
  }

  if (batchMode) {
    const selector = document.createElement("button");
    selector.className = `selection-toggle${selected ? " checked" : ""}`;
    selector.type = "button";
    selector.disabled = entry.active;
    selector.title = entry.active ? "正在使用的壁纸不会被批量删除" : selected ? "取消选择" : "选择壁纸";
    selector.setAttribute("aria-label", selector.title);
    selector.textContent = selected ? "✓" : "";
    selector.addEventListener("click", (event) => {
      event.stopPropagation();
      setSelected(entry.id, !selected);
    });
    preview.appendChild(selector);
  }

  preview.addEventListener("click", async () => {
    if (batchMode) {
      setSelected(entry.id, !selected);
      return;
    }
    await api.apply(entry.id);
    showToast(`已切换到“${entry.name}”`);
  });

  const footer = document.createElement("div");
  footer.className = "card-footer";
  const name = document.createElement("div");
  name.className = "card-name";
  const strong = document.createElement("strong");
  strong.textContent = entry.name;
  const meta = document.createElement("span");
  meta.textContent = `${entry.kind === "video" ? "动态壁纸" : "图片壁纸"} · ${formatDate(entry.createdAt)}`;
  name.append(strong, meta);

  const remove = document.createElement("button");
  remove.className = "delete-button";
  remove.title = "删除壁纸";
  remove.textContent = "×";
  remove.hidden = batchMode;
  remove.addEventListener("click", async (event) => {
    event.stopPropagation();
    if (!confirm(`从图库中删除“${entry.name}”？`)) return;
    await api.remove(entry.id);
    showToast("已从图库删除");
  });
  footer.append(name, remove);
  card.append(preview, footer);
  return card;
}

function updateBatchToolbar() {
  elements.batchToolbar.hidden = !batchMode;
  elements.batchModeButton.hidden = batchMode;
  elements.selectedCount.textContent = `已选择 ${selectedIds.size} 项`;
  elements.removeSelectedButton.disabled = selectedIds.size === 0;
  elements.removeSelectedButton.textContent = selectedIds.size ? `删除所选（${selectedIds.size}）` : "删除所选";
}

function render(state) {
  currentState = state;
  const existingIds = new Set(state.library.map((entry) => entry.id));
  for (const id of selectedIds) {
    if (!existingIds.has(id) || id === state.activeId) selectedIds.delete(id);
  }
  elements.grid.replaceChildren(...state.library.map(createCard));
  elements.empty.hidden = state.library.length > 0;
  const videos = state.library.filter((entry) => entry.kind === "video").length;
  elements.count.textContent = `${state.library.length} 个壁纸 · ${videos} 个视频`;
  updateBatchToolbar();

  elements.autoStart.checked = Boolean(state.settings.autoStart);
  const rotationEnabled = Boolean(state.settings.rotationEnabled);
  const canRotate = Boolean(state.rotation?.canRotate);
  elements.rotationEnabled.checked = rotationEnabled;
  elements.rotationInterval.value = String(state.settings.rotationIntervalMinutes || 30);
  elements.rotationMode.value = state.settings.rotationMode === "random" ? "random" : "sequential";
  elements.rotationInterval.disabled = !rotationEnabled;
  elements.rotationMode.disabled = !rotationEnabled;
  elements.rotateNowButton.disabled = !canRotate;
  if (!canRotate) {
    elements.rotationStatus.innerHTML = "至少需要 <strong>2 个壁纸</strong>才能轮换。";
  } else if (!rotationEnabled) {
    elements.rotationStatus.innerHTML = "定时轮换尚未开启，你仍然可以点击<strong>立即换一张</strong>。";
  } else if (state.rotation?.nextAt) {
    const nextTime = new Date(state.rotation.nextAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
    const modeText = state.settings.rotationMode === "random" ? "随机选择" : "按图库顺序";
    elements.rotationStatus.innerHTML = `<strong>运行中。</strong>下一次约在 ${nextTime} 轮换，当前采用${modeText}。`;
  } else {
    elements.rotationStatus.innerHTML = "<strong>已开启。</strong>正在等待安排下一次轮换。";
  }
  const lockScreen = state.lockScreen || {};
  elements.lockScreenSync.checked = Boolean(state.settings.lockScreenSync);
  elements.lockScreenSync.disabled = !lockScreen.supported;
  elements.applyLockScreenButton.disabled = !lockScreen.supported || !lockScreen.canApply || lockScreen.applying;
  elements.applyLockScreenButton.textContent = lockScreen.applying ? "正在设置锁屏…" : "将当前图片设为锁屏";
  elements.lockScreenStatus.classList.toggle("error", Boolean(lockScreen.error));
  if (!lockScreen.supported) {
    elements.lockScreenStatus.innerHTML = "<strong>锁屏组件不可用。</strong>请重新安装完整版本，或检查组件是否被安全软件隔离。";
  } else if (lockScreen.applying) {
    elements.lockScreenStatus.innerHTML = "<strong>正在更新 Windows 锁屏…</strong>通常几秒内完成。";
  } else if (lockScreen.error) {
    elements.lockScreenStatus.innerHTML = `<strong>设置失败。</strong>${lockScreen.error}`;
  } else if (!lockScreen.canApply) {
    elements.lockScreenStatus.innerHTML = "当前是<strong>视频壁纸</strong>。Windows 锁屏只支持静态图片，会保留上一次设置的锁屏。";
  } else if (lockScreen.lastAppliedId === state.activeId) {
    elements.lockScreenStatus.innerHTML = `<strong>已同步。</strong>${state.settings.lockScreenSync ? "以后切换图片壁纸时会继续自动更新。" : "当前图片已经设为 Windows 锁屏。"}`;
  } else if (state.settings.lockScreenSync) {
    elements.lockScreenStatus.innerHTML = lockScreen.message || "<strong>跟随已开启。</strong>当前图片将在后台同步到 Windows 锁屏。";
  } else {
    elements.lockScreenStatus.innerHTML = lockScreen.message || "开启跟随，或点击按钮将当前图片单独设为 Windows 锁屏。";
  }
  const showcase = state.showcase || {};
  const screensaverAutoEnabled = Boolean(state.settings.screensaverAutoEnabled);
  const screensaverRotationEnabled = Boolean(state.settings.screensaverRotationEnabled);
  const screensaverIdleMinutes = Number(state.settings.screensaverIdleMinutes || 5);
  const screensaverRotationMinutes = Number(state.settings.screensaverRotationIntervalMinutes || 2);
  const screensaverModeText = state.settings.screensaverRotationMode === "sequential" ? "按图库顺序" : "随机";
  elements.screensaverAutoEnabled.checked = screensaverAutoEnabled;
  elements.screensaverIdleMinutes.value = String(screensaverIdleMinutes);
  elements.screensaverRotationEnabled.checked = screensaverRotationEnabled;
  elements.screensaverRotationInterval.value = String(screensaverRotationMinutes);
  elements.screensaverRotationMode.value = state.settings.screensaverRotationMode === "sequential" ? "sequential" : "random";
  elements.screensaverRotationInterval.disabled = !screensaverRotationEnabled;
  elements.screensaverRotationMode.disabled = !screensaverRotationEnabled;
  elements.toggleShowcaseButton.disabled = !showcase.canStart;
  elements.toggleShowcaseButton.textContent = showcase.running ? "退出屏保并锁定" : "立即进入动态屏保";
  if (showcase.running) {
    const rotationText = screensaverRotationEnabled && state.library.length > 1
      ? `屏保正在${screensaverModeText}轮换，每 ${screensaverRotationMinutes} 分钟换一张。`
      : "屏保内容轮换已关闭。";
    elements.showcaseStatus.innerHTML = `<strong>动态屏保正在运行。</strong>移动鼠标不会退出；点击画面或按任意键后，将进入 Windows 登录界面。${rotationText}`;
  } else if (!screensaverAutoEnabled) {
    elements.showcaseStatus.innerHTML = "<strong>自动屏保未开启。</strong>你仍可以点上面按钮手动进入屏保。";
  } else {
    const rotationText = screensaverRotationEnabled
      ? `屏保每 <strong>${screensaverRotationMinutes} 分钟</strong>${screensaverModeText}换一张。`
      : "屏保内容不自动轮换。";
    elements.showcaseStatus.innerHTML = `<strong>无操作 ${screensaverIdleMinutes} 分钟后自动进入屏保。</strong>${rotationText}移动鼠标会重置等待计时，但屏保已出现时移动鼠标不会退出。点击或按键后进入 Windows 登录界面。`;
  }

  elements.fit.value = state.settings.fit || "cover";
  elements.muted.checked = Boolean(state.settings.muted);
  elements.volume.value = Math.round((state.settings.volume || 0) * 100);
  elements.positionX.value = state.settings.positionX ?? 50;
  elements.positionY.value = state.settings.positionY ?? 50;
  elements.volumeValue.textContent = `${elements.volume.value}%`;
  elements.positionXValue.textContent = `${elements.positionX.value}%`;
  elements.positionYValue.textContent = `${elements.positionY.value}%`;

  const ready = state.runtime.wallpaperAttached && state.runtime.helperPresent;
  elements.statusDot.classList.toggle("ready", ready);
  elements.statusText.textContent = ready ? "桌面壁纸正在运行" : "壁纸引擎正在准备";
}

function importMessage(operation) {
  if (!operation || operation.canceled) return "";
  const parts = [];
  if (operation.imported) parts.push(`已导入 ${operation.imported} 个壁纸`);
  if (operation.duplicates) parts.push(`跳过 ${operation.duplicates} 个重复文件`);
  if (operation.unsupported) parts.push(`忽略 ${operation.unsupported} 个不支持的文件`);
  return parts.join("，") || "没有可导入的壁纸";
}

async function importMedia() {
  elements.importButton.disabled = true;
  try {
    const next = await api.importMedia();
    render(next);
    const message = importMessage(next.operation);
    if (message) showToast(message);
  } catch (error) {
    showToast(`导入失败：${error.message || error}`);
  } finally {
    elements.importButton.disabled = false;
  }
}

function updateSettings(patch, message) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      const next = await api.updateSettings(patch);
      render(next);
      if (message) showToast(message);
    } catch (error) {
      showToast(`保存设置失败：${error.message || error}`, true);
    }
  }, 120);
}

function finishBatchMode() {
  batchMode = false;
  selectedIds.clear();
  if (currentState) render(currentState);
}

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => {
    document.querySelectorAll(".nav-item").forEach((item) => item.classList.toggle("active", item === button));
    const settings = button.dataset.view === "settings";
    document.getElementById("libraryView").classList.toggle("active", !settings);
    document.getElementById("settingsView").classList.toggle("active", settings);
    document.getElementById("pageTitle").textContent = settings ? "播放设置" : "我的壁纸";
    document.getElementById("pageSubtitle").textContent = settings ? "控制启动、显示位置和视频播放方式。" : "选择图片或视频，立即应用到 Windows 桌面。";
    elements.importButton.style.visibility = settings ? "hidden" : "visible";
    if (settings && batchMode) finishBatchMode();
  });
});

elements.importButton.addEventListener("click", importMedia);
elements.emptyImportButton.addEventListener("click", importMedia);
elements.restartEngineButton.addEventListener("click", async () => {
  elements.restartEngineButton.disabled = true;
  try {
    const next = await api.restartEngine();
    render(next);
    showToast("正在重新启动壁纸引擎");
  } catch (error) {
    showToast(`重启失败：${error.message || error}`, true);
  } finally {
    setTimeout(() => { elements.restartEngineButton.disabled = false; }, 1200);
  }
});
elements.openLogsButton.addEventListener("click", async () => {
  try { await api.openLogs(); }
  catch (error) { showToast(`打开日志失败：${error.message || error}`, true); }
});
elements.batchModeButton.addEventListener("click", () => {
  batchMode = true;
  selectedIds.clear();
  render(currentState);
});
elements.finishBatchButton.addEventListener("click", finishBatchMode);
elements.clearSelectionButton.addEventListener("click", () => {
  selectedIds.clear();
  render(currentState);
});
elements.selectAllButton.addEventListener("click", () => {
  selectedIds.clear();
  for (const entry of currentState.library) {
    if (!entry.active) selectedIds.add(entry.id);
  }
  render(currentState);
});
elements.removeSelectedButton.addEventListener("click", async () => {
  if (!selectedIds.size) return;
  const count = selectedIds.size;
  if (!confirm(`确定从图库中删除选中的 ${count} 个壁纸？此操作无法撤销。`)) return;
  elements.removeSelectedButton.disabled = true;
  try {
    const next = await api.removeMany([...selectedIds]);
    const removed = next.operation?.removed || 0;
    selectedIds.clear();
    render(next);
    showToast(`已批量删除 ${removed} 个壁纸`);
  } catch (error) {
    showToast(`批量删除失败：${error.message || error}`);
  }
});
elements.autoStart.addEventListener("change", () => updateSettings({ autoStart: elements.autoStart.checked }, elements.autoStart.checked ? "已开启开机自动启动" : "已关闭开机自动启动"));
elements.screensaverAutoEnabled.addEventListener("change", () => updateSettings(
  { screensaverAutoEnabled: elements.screensaverAutoEnabled.checked },
  elements.screensaverAutoEnabled.checked ? "已开启自动屏保" : "已关闭自动屏保",
));
elements.screensaverIdleMinutes.addEventListener("change", () => updateSettings(
  { screensaverIdleMinutes: Number(elements.screensaverIdleMinutes.value) },
  "自动屏保等待时间已更新",
));
elements.screensaverRotationEnabled.addEventListener("change", () => updateSettings(
  { screensaverRotationEnabled: elements.screensaverRotationEnabled.checked },
  elements.screensaverRotationEnabled.checked ? "已开启屏保内容轮换" : "已关闭屏保内容轮换",
));
elements.screensaverRotationInterval.addEventListener("change", () => updateSettings(
  { screensaverRotationIntervalMinutes: Number(elements.screensaverRotationInterval.value) },
  "屏保轮换间隔已更新",
));
elements.screensaverRotationMode.addEventListener("change", () => updateSettings(
  { screensaverRotationMode: elements.screensaverRotationMode.value },
  elements.screensaverRotationMode.value === "random" ? "已改为随机轮换" : "已改为顺序轮换",
));
elements.rotationEnabled.addEventListener("change", () => updateSettings(
  { rotationEnabled: elements.rotationEnabled.checked },
  elements.rotationEnabled.checked ? "已开启定时轮换" : "已关闭定时轮换",
));
elements.rotationInterval.addEventListener("change", () => updateSettings(
  { rotationIntervalMinutes: Number(elements.rotationInterval.value) },
  "轮换间隔已更新",
));
elements.rotationMode.addEventListener("change", () => updateSettings(
  { rotationMode: elements.rotationMode.value },
  elements.rotationMode.value === "random" ? "已改为随机轮换" : "已改为顺序轮换",
));
elements.lockScreenSync.addEventListener("change", () => updateSettings(
  { lockScreenSync: elements.lockScreenSync.checked },
  elements.lockScreenSync.checked ? "已开启锁屏跟随" : "已关闭锁屏跟随",
));
elements.applyLockScreenButton.addEventListener("click", async () => {
  elements.applyLockScreenButton.disabled = true;
  try {
    const next = await api.applyLockScreen();
    render(next);
    const result = next.operation?.lockScreen;
    showToast(result?.ok ? "当前图片已设为 Windows 锁屏" : (result?.message || "锁屏设置失败"), !result?.ok);
  } catch (error) {
    showToast(`锁屏设置失败：${error.message || error}`, true);
  } finally {
    if (currentState) elements.applyLockScreenButton.disabled = !currentState.lockScreen?.canApply || currentState.lockScreen?.applying;
  }
});
elements.toggleShowcaseButton.addEventListener("click", async () => {
  elements.toggleShowcaseButton.disabled = true;
  try {
    const next = await api.toggleShowcase();
    render(next);
    showToast(next.showcase?.running ? "动态屏保已启动：移动鼠标不退出，点击或按键后进入登录界面" : "已退出屏保并请求锁定 Windows");
  } catch (error) {
    showToast(`动态屏保切换失败：${error.message || error}`, true);
  } finally {
    if (currentState) elements.toggleShowcaseButton.disabled = !currentState.showcase?.canStart;
  }
});
elements.rotateNowButton.addEventListener("click", async () => {
  elements.rotateNowButton.disabled = true;
  try {
    const next = await api.rotateNow();
    render(next);
    showToast(next.operation?.rotated ? "已切换到下一张壁纸" : "至少需要两个壁纸才能轮换");
  } catch (error) {
    showToast(`轮换失败：${error.message || error}`, true);
  } finally {
    if (currentState) elements.rotateNowButton.disabled = !currentState.rotation?.canRotate;
  }
});
elements.fit.addEventListener("change", () => updateSettings({ fit: elements.fit.value }, "显示方式已更新"));
elements.muted.addEventListener("change", () => updateSettings({ muted: elements.muted.checked }, elements.muted.checked ? "视频已静音" : "已开启视频声音"));
elements.volume.addEventListener("input", () => {
  elements.volumeValue.textContent = `${elements.volume.value}%`;
  updateSettings({ volume: Number(elements.volume.value) / 100 });
});
elements.positionX.addEventListener("input", () => {
  elements.positionXValue.textContent = `${elements.positionX.value}%`;
  updateSettings({ positionX: Number(elements.positionX.value) });
});
elements.positionY.addEventListener("input", () => {
  elements.positionYValue.textContent = `${elements.positionY.value}%`;
  updateSettings({ positionY: Number(elements.positionY.value) });
});

api.onState(render);
api.getState().then(render).catch((error) => {
  elements.statusText.textContent = "壁纸引擎启动失败";
  showToast(error.message || String(error), true);
});
