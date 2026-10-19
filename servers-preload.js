// The Servers panel's bridge to the manager in the main process.
const { contextBridge, ipcRenderer } = require('electron');

const call = (action, ...args) => ipcRenderer.invoke('mgr', action, ...args);
contextBridge.exposeInMainWorld('mgr', {
  status: () => call('status'),
  start: (key) => call('start', key),
  stop: (key) => call('stop', key),
  restart: (key) => call('restart', key),
  endSession: (pid) => call('endSession', pid),
  stopUnmanaged: (pid) => call('stopUnmanaged', pid),
  keep: (id, on) => call('keep', id, on),
  setCleanup: (on) => call('setCleanup', on),
  reap: (dryRun) => call('reap', dryRun),
  mcpList: (key) => call('mcpList', key),
  mcpLogin: (key, name) => call('mcpLogin', key, name),
  mcpCancel: (key, name) => call('mcpCancel', key, name),
  mcpAdd: (key, input) => call('mcpAdd', key, input),
  mcpRemove: (key, name, scope) => call('mcpRemove', key, name, scope),
  mcpTerminal: (key) => call('mcpTerminal', key),
  openConfig: () => call('openConfig'),
  packaged: () => call('packaged'),
});
