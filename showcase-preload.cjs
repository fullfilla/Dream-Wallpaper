const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dynamicShowcase", {
  ready: () => ipcRenderer.send("showcase:ready"),
  exitAndLock: () => ipcRenderer.send("showcase:exit-and-lock"),
  onState: (listener) => {
    const wrapped = (_event, state) => listener(state);
    ipcRenderer.on("showcase:state", wrapped);
    return () => ipcRenderer.removeListener("showcase:state", wrapped);
  },
});
