const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('copilot', {
  onListeningToggled: (cb) => ipcRenderer.on('listening-toggled', (_e, val) => cb(val)),
  onManualTrigger: (cb) => ipcRenderer.on('manual-trigger', () => cb()),
  onScreenshotTrigger: (cb) => ipcRenderer.on('screenshot-trigger', () => cb()),
  getListeningState: () => ipcRenderer.invoke('get-listening-state'),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  resizeWindow: (height) => ipcRenderer.invoke('resize-window', { height }),
  getProviderConfig: () => ipcRenderer.invoke('get-provider-config'),
  saveProviderConfig: (config) => ipcRenderer.invoke('save-provider-config', config),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
});
