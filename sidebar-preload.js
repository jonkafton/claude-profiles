// The sidebar's only bridge to the main process: list profiles, pick one (or an app screen), and hear
// which is active, how each profile's servers are doing, and when the profile list changes.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('profiles', {
  list: () => ipcRenderer.invoke('profiles'),
  select: (id) => ipcRenderer.send('select', id),
  onActive: (fn) => ipcRenderer.on('active', (_e, id) => fn(id)),
  onStatus: (fn) => ipcRenderer.on('status', (_e, status) => fn(status)),
  onChanged: (fn) => ipcRenderer.on('profiles-changed', () => fn()),
});
