// The Profiles screen's bridge to the main process.
const { contextBridge, ipcRenderer } = require('electron');

const call = (action, ...args) => ipcRenderer.invoke('editor', action, ...args);
contextBridge.exposeInMainWorld('editor', {
  list: () => call('list'),
  chooseFolders: () => call('chooseFolders'),
  chooseConfigDir: () => call('chooseConfigDir'),
  chooseIcon: () => call('chooseIcon'),
  save: (input) => call('save', input),
  remove: (id) => call('remove', id),
  cliLogin: (id) => call('cliLogin', id),
  trustFolder: (id, folder) => call('trustFolder', id, folder),
  openProfile: (id) => call('openProfile', id),
  openServers: () => call('openServers'),
  onNew: (fn) => ipcRenderer.on('editor-new', () => fn()),
});
