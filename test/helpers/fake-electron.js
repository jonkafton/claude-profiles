// A small in-memory Electron, enough to load main.js and the preloads in plain Node and drive them:
// windows and views record what is done to them, ipcMain keeps its handlers, sessions route fetch() to
// test-defined handlers, and images are described rather than decoded.
'use strict';

const Module = require('node:module');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const state = {};
function resetState() {
  Object.assign(state, {
    handlers: new Map(), // ipcMain.handle
    listeners: new Map(), // ipcMain.on
    windows: [], // every BaseWindow / BrowserWindow
    views: [], // every WebContentsView
    sessions: new Map(), // partition -> FakeSession
    routes: [], // { method, test(url), reply(url, opts, session) }
    fetches: [], // { partition, url, method, body }
    menus: [], // Menu.buildFromTemplate results
    appMenu: null,
    externals: [], // shell.openExternal
    openedPaths: [],
    clipboard: '',
    dialogs: [], // showMessageBox calls
    messageBoxResponse: 0,
    errorBoxes: [],
    openDialogResult: { canceled: true, filePaths: [] },
    openDialogs: [],
    images: new Map(), // path -> 'full' | 'margins'
    dockIcons: [],
    quits: 0,
    singleInstance: true,
    focusedWindow: null,
    exposed: {}, // contextBridge
    rendererInvokes: [],
    rendererSends: [],
    rendererOn: [],
    cookies: new Map(), // partition -> [{ name, value }]
    localStorage: new Map(), // partition -> Map
    userData: null,
    nextId: 1,
  });
}
resetState();

// ---- images ---------------------------------------------------------------------------------------
class FakeImage {
  constructor(kind, width = 1024, height = width, bitmap = null) { this.kind = kind; this.width = width; this.height = height; this.bitmap = bitmap; }
  isEmpty() { return !this.kind; }
  getSize() { return { width: this.width, height: this.height }; }
  resize({ width, height }) { return new FakeImage(this.kind, width, height ?? width); }
  // 'full' fills the whole square; 'margins' leaves a transparent band a tenth of the size on every side.
  toBitmap() {
    if (this.bitmap) return this.bitmap;
    const { width: w, height: h } = this;
    const buf = Buffer.alloc(w * h * 4);
    const m = this.kind === 'margins' ? Math.ceil(w / 10) : 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const inside = x >= m && x < w - m && y >= m && y < h - m;
      buf[i] = 200; buf[i + 1] = 100; buf[i + 2] = 50; buf[i + 3] = inside ? 255 : 0;
    }
    return buf;
  }
  toDataURL() { return `data:image/png;base64,${Buffer.from(`${this.kind}-${this.width}`).toString('base64')}`; }
  toPNG() { return Buffer.from(`PNG ${this.kind} ${this.width}x${this.height}`); }
}
const nativeImage = {
  createFromPath: (p) => new FakeImage(state.images.get(p) || null),
  createFromDataURL: (u) => new FakeImage(/^data:image\/png;base64,.+/.test(u) && !u.endsWith(',ZW1wdHk=') ? 'full' : null),
  createFromBitmap: (buf, { width, height }) => new FakeImage('bitmap', width, height, buf),
};

// ---- sessions ---------------------------------------------------------------------------------------
class FakeSession {
  constructor(partition) {
    this.partition = partition;
    this.userAgent = null;
    this.permissionRequestHandler = null;
    this.permissionCheckHandler = null;
    this.webRequest = { onCompleted: () => {} };
    this.cookies = { get: async ({ name }) => (state.cookies.get(partition) || []).filter((c) => !name || c.name === name) };
  }
  setUserAgent(ua) { this.userAgent = ua; }
  setPermissionRequestHandler(fn) { this.permissionRequestHandler = fn; }
  setPermissionCheckHandler(fn) { this.permissionCheckHandler = fn; }
  async fetch(url, opts = {}) {
    const method = opts.method || 'GET';
    state.fetches.push({ partition: this.partition, url, method, body: opts.body, headers: opts.headers });
    for (let i = state.routes.length - 1; i >= 0; i--) {
      const r = state.routes[i];
      if ((r.method === '*' || r.method === method) && r.test(url)) {
        const out = await r.reply(url, opts, this);
        if (out instanceof Error) throw out;
        if (out instanceof Response) return out;
        return new Response(JSON.stringify(out ?? {}), { status: 200, headers: { 'content-type': 'application/json' } });
      }
    }
    return new Response('not found', { status: 404 });
  }
}
const session = {
  fromPartition(partition) {
    if (!state.sessions.has(partition)) state.sessions.set(partition, new FakeSession(partition));
    return state.sessions.get(partition);
  },
};

// ---- web contents, views, windows ------------------------------------------------------------------
class FakeWebContents extends EventEmitter {
  constructor(prefs = {}) {
    super();
    this.prefs = prefs;
    this.session = prefs.session || null;
    this.url = '';
    this.title = '';
    this.loading = false;
    this.destroyed = false;
    this.sent = [];
    this.loads = [];
    this.reloads = 0;
    this.focused = 0;
    this.windowOpenHandler = null;
    this.navigationHistory = { goBack: () => this.loads.push('<back>'), goForward: () => this.loads.push('<forward>') };
  }
  loadURL(url) {
    this.url = url;
    this.loads.push(url);
    return Promise.resolve();
  }
  loadFile(file) {
    this.file = file;
    this.url = `file://${file}`;
    this.loads.push(this.url);
    setImmediate(() => { if (!this.destroyed) this.emit('did-finish-load'); });
    return Promise.resolve();
  }
  getURL() { return this.url; }
  getTitle() { return this.title; }
  isLoading() { return this.loading; }
  isDestroyed() { return this.destroyed; }
  close() { if (!this.destroyed) { this.destroyed = true; this.emit('destroyed'); } }
  focus() { this.focused++; }
  reload() { this.reloads++; }
  send(channel, ...args) { if (this.destroyed) throw new Error('Object has been destroyed'); this.sent.push([channel, ...args]); }
  setWindowOpenHandler(fn) { this.windowOpenHandler = fn; }
  toggleDevTools() { this.devTools = !this.devTools; }
  replaceMisspelling(s) { this.replaced = s; }
  copyImageAt(x, y) { this.copiedImageAt = [x, y]; }
  inspectElement(x, y) { this.inspectedAt = [x, y]; }
  // Runs the script against this session's fake localStorage, the way the page would.
  async executeJavaScript(code) {
    const partition = this.session?.partition || 'default';
    if (!state.localStorage.has(partition)) state.localStorage.set(partition, new Map());
    const store = state.localStorage.get(partition);
    const localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) };
    return new Function('localStorage', `return (${code});`)(localStorage);
  }
  // Test helpers: what a real page would do.
  navigate(url) { this.url = url; this.emit('did-navigate', {}, url); }
  navigateInPage(url) { this.url = url; this.emit('did-navigate-in-page', {}, url); }
  willNavigate(url) { const e = { prevented: false, preventDefault() { this.prevented = true; } }; this.emit('will-navigate', e, url); return e.prevented; }
  open(url) { return this.windowOpenHandler({ url }); }
  sentOn(channel) { return this.sent.filter((s) => s[0] === channel).map((s) => s.slice(1)); }
}

class WebContentsView {
  constructor({ webPreferences = {} } = {}) {
    this.webPreferences = webPreferences;
    this.webContents = new FakeWebContents(webPreferences);
    this.bounds = null;
    this.visible = true;
    state.views.push(this);
  }
  setBounds(b) { this.bounds = b; }
  setVisible(v) { this.visible = v; }
}

class BaseWindow extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.id = state.nextId++;
    this.destroyed = false;
    this.title = '';
    this.bounds = { x: opts.x ?? 0, y: opts.y ?? 0, width: opts.width ?? 800, height: opts.height ?? 600 };
    this.minimized = false;
    const children = [];
    this.contentView = {
      children,
      addChildView: (v) => { children.push(v); },
      removeChildView: (v) => { const i = children.indexOf(v); if (i < 0) throw new Error('not a child'); children.splice(i, 1); },
    };
    state.windows.push(this);
  }
  static getFocusedWindow() { return state.focusedWindow && !state.focusedWindow.destroyed ? state.focusedWindow : null; }
  getBounds() { if (this.destroyed) throw new Error('Object has been destroyed'); return { ...this.bounds }; }
  getContentBounds() { return { x: 0, y: 0, width: this.bounds.width, height: this.bounds.height - 28 }; }
  setTitle(t) { this.title = t; }
  isDestroyed() { return this.destroyed; }
  isFocused() { return state.focusedWindow === this; }
  isMinimized() { return this.minimized; }
  isVisible() { return !this.destroyed; }
  restore() { this.minimized = false; }
  focus() { state.focusedWindow = this; this.emit('focus'); }
  setVisibleOnAllWorkspaces() {}
  close() {
    if (this.destroyed) return;
    this.emit('close');
    this.destroyed = true;
    if (state.focusedWindow === this) state.focusedWindow = null;
    this.emit('closed');
  }
  destroy() { this.destroyed = true; this.emit('closed'); }
  // Test helper: resize as a user would.
  resize(width, height) { this.bounds = { ...this.bounds, width, height }; this.emit('resize'); }
}

class BrowserWindow extends BaseWindow {
  constructor(opts = {}) {
    super(opts);
    this.webContents = new FakeWebContents(opts.webPreferences || {});
  }
  loadURL(url) { return this.webContents.loadURL(url); }
}

// ---- the rest -------------------------------------------------------------------------------------
const ipcMain = {
  handle: (ch, fn) => state.handlers.set(ch, fn),
  on: (ch, fn) => state.listeners.set(ch, fn),
};

class FakeApp extends EventEmitter {
  constructor() {
    super();
    this.isPackaged = false;
    this.userAgentFallback = '';
    this.dock = { setIcon: (img) => state.dockIcons.push(img) };
  }
  getPath(name) { if (name !== 'userData') throw new Error(`fake app: no path ${name}`); return state.userData; }
  setPath(name, p) { if (name === 'userData') state.userData = p; }
  requestSingleInstanceLock() { return state.singleInstance; }
  quit() { state.quits++; this.emit('before-quit'); }
  whenReady() { return Promise.resolve(); }
}

const electron = {
  app: null,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
  nativeImage,
  shell: {
    openExternal: (u) => { state.externals.push(u); return Promise.resolve(); },
    openPath: (p) => { state.openedPaths.push(p); return Promise.resolve(''); },
  },
  clipboard: { writeText: (t) => { state.clipboard = t; }, readText: () => state.clipboard },
  Menu: {
    buildFromTemplate: (template) => { const m = { template, popups: 0, popup() { this.popups++; } }; state.menus.push(m); return m; },
    setApplicationMenu: (m) => { state.appMenu = m; },
  },
  dialog: {
    showMessageBox: async (...args) => { state.dialogs.push(args.at(-1)); return { response: state.messageBoxResponse }; },
    showErrorBox: (title, message) => state.errorBoxes.push({ title, message }),
    showOpenDialog: async (_w, options) => { state.openDialogs.push(options); return state.openDialogResult; },
  },
  contextBridge: { exposeInMainWorld: (name, api) => { state.exposed[name] = api; } },
  ipcRenderer: {
    invoke: (...args) => { state.rendererInvokes.push(args); return Promise.resolve(args); },
    send: (...args) => state.rendererSends.push(args),
    on: (ch, fn) => state.rendererOn.push([ch, fn]),
  },
};

function reset() {
  resetState();
  electron.app = new FakeApp();
}
reset();

// Route `require('electron')` here, for main.js and the preloads.
const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electron;
  return load.call(this, request, parent, isMain);
};

// fetch routes: a string matches when the URL contains it; a RegExp is tested.
function route(method, match, reply) {
  const test = typeof match === 'string' ? (u) => u.includes(match) : (u) => match.test(u);
  state.routes.push({ method, test, reply: typeof reply === 'function' ? reply : () => reply });
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

module.exports = { electron, state, reset, route, json, FakeImage, FakeWebContents };
