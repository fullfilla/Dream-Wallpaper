const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dreamWallpaper", {
  getState: () => ipcRenderer.invoke("wallpaper:get-state"),
  importMedia: () => ipcRenderer.invoke("wallpaper:import"),
  apply: (id) => ipcRenderer.invoke("wallpaper:apply", id),
  remove: (id) => ipcRenderer.invoke("wallpaper:remove", id),
  removeMany: (ids) => ipcRenderer.invoke("wallpaper:remove-many", ids),
  updateSettings: (patch) => ipcRenderer.invoke("wallpaper:update-settings", patch),
  rotateNow: () => ipcRenderer.invoke("wallpaper:rotate-now"),
  applyLockScreen: () => ipcRenderer.invoke("wallpaper:apply-lock-screen"),
  toggleShowcase: () => ipcRenderer.invoke("wallpaper:toggle-showcase"),
  restartEngine: () => ipcRenderer.invoke("wallpaper:restart-engine"),
  openLogs: () => ipcRenderer.invoke("wallpaper:open-logs"),
  openPanel: () => ipcRenderer.invoke("wallpaper:show-panel"),
  quit: () => ipcRenderer.invoke("wallpaper:quit"),
  onState: (listener) => {
    const wrapped = (_event, state) => listener(state);
    ipcRenderer.on("wallpaper:state", wrapped);
    return () => ipcRenderer.removeListener("wallpaper:state", wrapped);
  },
});
