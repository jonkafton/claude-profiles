// Loads a fresh copy of main.js against the fake Electron, a fake manager and a sandboxed data folder.
// Timers are mocked for the test (t.mock.timers), so main.js's status and cleanup intervals never run on
// their own and vanish with the test; tick them to make them run.
'use strict';
const sb = require('./sandbox');
const fakeCp = require('./fake-child-process');
const fe = require('./fake-electron');
const Module = require('node:module');
const path = require('node:path');

const MAIN = path.join(__dirname, '..', '..', 'main.js');
const MANAGER = path.join(__dirname, '..', '..', 'manager.js');

// ---- fake manager -------------------------------------------------------------------------------------
const mgr = { calls: [], impl: {}, opts: null };
const emptyStatus = () => ({ servers: [], unmanaged: [], desktop: { count: 0, rssMB: 0 }, cleanup: {}, log: [] });
const defaults = {
  status: async () => emptyStatus(),
  claudeConfig: () => ({ account: null, trusted: false, remoteAccepted: false }),
  log: () => {},
  startServer: async () => {},
  stopServer: async () => {},
  continueSession: async () => ({ skipped: 'test default' }),
  mcpTarget: (key) => { throw new Error(`no server ${key}`); },
  designStatus: async () => ({ available: true, signed_in: false, can_sign_in_here: true }),
  designLogin: async () => ({ done: new Promise(() => {}), cancel() {} }),
};
function createManager(opts) {
  mgr.opts = opts;
  return new Proxy({}, {
    get: (_t, name) => (...args) => {
      mgr.calls.push([name, ...args]);
      const f = mgr.impl[name] || defaults[name];
      return f ? f(...args) : undefined;
    },
  });
}
const callsOf = (name) => mgr.calls.filter((c) => c[0] === name).map((c) => c.slice(1));

const load = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename === MAIN && request === './manager') return { createManager };
  return load.call(this, request, parent, isMain);
};

// ---- loading main.js --------------------------------------------------------------------------------
async function settle(rounds = 12) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}

async function loadMain(t, { profiles = [], extra = {}, saved, singleInstance = true, rawProfilesJson, env = {}, now } = {}) {
  fe.reset();
  fakeCp.reset();
  mgr.calls.length = 0;
  mgr.impl = {};
  // A test may load main.js twice; the second copy replaces the first, timers included.
  t.mock.timers.reset();
  t.mock.timers.enable(now === undefined ? { apis: ['setTimeout', 'setInterval'] } : { apis: ['setTimeout', 'setInterval', 'Date'], now });
  const configDir = sb.dir('data');
  const userData = sb.dir('userdata');
  if (rawProfilesJson !== undefined) {
    require('node:fs').writeFileSync(path.join(configDir, 'profiles.json'), rawProfilesJson);
  } else {
    sb.writeJson(path.join(configDir, 'profiles.json'), { ...extra, profiles });
  }
  if (saved) sb.writeJson(path.join(userData, 'state.json'), saved);
  const vars = { CLAUDE_PROFILES_DIR: configDir, CLAUDE_PROFILES_USER_DATA: userData, ...env };
  Object.assign(process.env, vars);
  t.after(() => { for (const k of Object.keys(vars)) delete process.env[k]; });
  fe.state.singleInstance = singleInstance;
  delete require.cache[MAIN];
  require(MAIN);
  await settle();
  return makeHandle(configDir, userData);
}

function makeHandle(configDir, userData) {
  const appWindows = () => fe.state.windows.filter((w) => !(w instanceof fe.electron.BrowserWindow) && !w.destroyed);
  const sidebarOf = (w) => w.contentView.children[0];
  const contentViews = (w) => w.contentView.children.slice(1);
  const partitionOf = (v) => v.webPreferences.session?.partition || null;
  const panelOf = (v) => (v.webPreferences.preload ? path.basename(v.webPreferences.preload, '-preload.js') : null);
  const activeView = (w) => contentViews(w).find((v) => v.visible) || null;
  const h = {
    configDir,
    userData,
    file: (...p) => path.join(configDir, ...p),
    appWindows,
    win: (i = 0) => appWindows()[i],
    sidebarOf,
    contentViews,
    activeView,
    partitionOf,
    panelOf,
    // The view showing a profile (by partition) or a panel ('servers', 'profiles') in a window.
    viewFor: (w, which) => contentViews(w).find((v) => partitionOf(v) === `persist:profile-${which}` || panelOf(v) === which),
    // The id the window shows: the sidebar is told on every change.
    activeId: (w) => sidebarOf(w).webContents.sentOn('active').at(-1)?.[0],
    select: async (w, id) => { fe.state.listeners.get('select')({ sender: sidebarOf(w).webContents }, id); await settle(); },
    invoke: (channel, sender, ...args) => fe.state.handlers.get(channel)({ sender }, ...args),
    mgrCall: async (w, action, ...args) => {
      await h.select(w, '__servers');
      return h.invoke('mgr', h.viewFor(w, 'servers').webContents, action, ...args);
    },
    editorCall: async (w, action, ...args) => {
      if (!h.viewFor(w, 'profiles')) await h.select(w, '__profiles');
      return h.invoke('editor', h.viewFor(w, 'profiles').webContents, action, ...args);
    },
    menuItem: (...labels) => {
      let items = fe.state.appMenu.template;
      let item;
      for (const label of labels) {
        item = items.find((i) => i.label === label || i.role === label);
        if (!item) throw new Error(`no menu item ${labels.join(' > ')}`);
        items = item.submenu || [];
      }
      return item;
    },
    settle,
  };
  return h;
}

module.exports = { sb, fakeCp, fe, mgr, callsOf, emptyStatus, loadMain, settle };
