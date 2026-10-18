// Claude Profiles: windows with a sidebar of Claude accounts, each signed in inside its own isolated
// browser session (cookies, storage and cache never cross between profiles).
//
// Every window is independent: its own sidebar and active profile, so windows can sit on different
// macOS desktops, including several on the same account (they share that account's sign-in).
// Profiles live in profiles.json in the app's data folder and are created and edited on the Profiles
// screen. The Servers screen manages each profile's Claude Code Remote Control servers (manager.js);
// the servers are launchd jobs running this app's own helper, so they keep going when the app quits.
// Links to anything outside Claude open in the default browser; Claude links stay in the profile.

const { app, BaseWindow, WebContentsView, ipcMain, shell, session, Menu, nativeImage, clipboard, dialog } = require('electron');
const { execFile } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const P = require('./profiles');
const { createManager } = require('./manager');

const CONFIG_DIR = process.env.CLAUDE_PROFILES_DIR || P.DEFAULT_CONFIG_DIR;
const SIDEBAR_WIDTH = 76;
// The app's own screens occupy a window's content area the way a profile does.
const SERVERS = '__servers';
const PROFILES = '__profiles';
const PANELS = {
  [SERVERS]: { page: 'servers.html', preload: 'servers-preload.js', title: 'Servers' },
  [PROFILES]: { page: 'profiles.html', preload: 'profiles-preload.js', title: 'Profiles' },
};
// Google and others refuse sign-in from user agents that name Electron; present as the Chrome we embed.
const CHROME_UA = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${process.versions.chrome} Safari/537.36`;
const CLAUDE_HOSTS = [/(^|\.)claude\.ai$/, /(^|\.)claude\.com$/, /(^|\.)anthropic\.com$/];
// Sign-in providers Claude's login bounces through. Any other host is still allowed while a profile is
// mid-login (see isSigningIn), so an organisation's own SSO chain works without being listed here.
const AUTH_HOSTS = [/^accounts\.google\.com$/, /^accounts\.youtube\.com$/, /^appleid\.apple\.com$/, /^login\.microsoftonline\.com$/];
const ALLOWED_PERMISSIONS = new Set(['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'media']);
const EMAIL_SIGN_IN_HELP = 'Choose "Continue with email" on the Claude sign-in page and enter the same address. Open the link in the email: in your normal browser it shows a verification code. Type that code into this app. (Or copy the link and press ⇧⌘V here, with this profile selected, to open it in this profile.)';

// Testing only: keep sign-ins and window state somewhere other than the real app's data folder.
if (process.env.CLAUDE_PROFILES_USER_DATA) app.setPath('userData', process.env.CLAUDE_PROFILES_USER_DATA);

const mgr = createManager({
  configDir: CONFIG_DIR,
  appBinary: process.execPath,
  // launchd runs the helper with this binary as plain Node; it must sit outside the asar archive.
  helperPath: app.isPackaged ? path.join(process.resourcesPath, 'app.asar.unpacked', 'helper.js') : path.join(__dirname, 'helper.js'),
});

let config;
// BaseWindow.id -> { win, sidebar: WebContentsView, views: Map<id, WebContentsView>, activeId }.
// The sidebar is its own view rather than the window's page: a window's page stops painting once
// other views sit on top of it.
const windows = new Map();
const sessionsReady = new Set();
const statePath = () => path.join(app.getPath('userData'), 'state.json');

function loadConfig() {
  const raw = P.readRaw(CONFIG_DIR);
  const ids = new Set();
  for (const p of raw.profiles) {
    if (!/^[a-z0-9-]+$/.test(p.id) || ids.has(p.id)) throw new Error(`bad or duplicate profile id "${p.id}"`);
    ids.add(p.id);
    p.url ||= P.DEFAULT_URL;
    p.iconPath = p.icon ? path.resolve(CONFIG_DIR, P.expand(p.icon)) : null;
  }
  return raw;
}

function readState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return {}; }
}
function saveWindows() {
  const list = [...windows.values()].filter((w) => !w.win.isDestroyed()).map((w) => ({ bounds: w.win.getBounds(), activeId: w.activeId }));
  try { fs.writeFileSync(statePath(), JSON.stringify({ windows: list })); } catch { /* best effort */ }
}

const profile = (id) => config.profiles.find((p) => p.id === id);
const isPanel = (id) => Object.hasOwn(PANELS, id);
const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };
const matches = (url, list) => list.some((re) => re.test(hostOf(url)));
const isWeb = (url) => /^https?:\/\//i.test(url);
const windowOf = (contents) => [...windows.values()].find((w) => w.sidebar.webContents === contents || [...w.views.values()].some((v) => v.webContents === contents));

// True while a profile is on a login page or out on an identity provider, where every hop must stay in-app.
function isSigningIn(contents) {
  const current = contents.getURL();
  if (!current || current === 'about:blank') return true;
  if (!matches(current, CLAUDE_HOSTS)) return true;
  return /^\/(login|logout|magic-link|oauth|sso|signup)/.test(new URL(current).pathname);
}

function openExternal(url) {
  if (isWeb(url) || url.startsWith('mailto:')) shell.openExternal(url);
}

// Applied to every profile view, and recursively to any window a profile opens (sign-in pop-ups,
// Claude links in a new window). Those windows inherit the opener's session, so they stay isolated.
function guardContents(contents) {
  contents.setWindowOpenHandler(({ url }) => {
    if (matches(url, CLAUDE_HOSTS) || matches(url, AUTH_HOSTS) || isSigningIn(contents)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1100, height: 800, webPreferences: { sandbox: true, contextIsolation: true } } };
    }
    openExternal(url);
    return { action: 'deny' };
  });
  contents.on('did-create-window', (child) => guardContents(child.webContents));
  // Google refuses sign-in inside embedded browsers whatever the user agent says. Don't leave the
  // person on its dead end: go back to Claude's sign-in and explain the email route.
  contents.on('did-navigate', (_e, url) => {
    if (!/^accounts\.google\.com$/.test(hostOf(url)) || !/rejected/.test(new URL(url).pathname)) return;
    if (windowOf(contents)) contents.loadURL('https://claude.ai/login'); else contents.close();
    dialog.showMessageBox({ type: 'info', message: 'Google does not allow signing in from inside apps like this one. Sign in by email instead.', detail: EMAIL_SIGN_IN_HELP });
  });
  contents.on('will-navigate', (event, url) => {
    if (!isWeb(url) || matches(url, CLAUDE_HOSTS) || matches(url, AUTH_HOSTS) || isSigningIn(contents)) return;
    event.preventDefault();
    openExternal(url);
  });
  contents.on('context-menu', (_e, params) => {
    const items = [];
    if (params.linkURL) {
      items.push({ label: 'Open Link in Browser', click: () => openExternal(params.linkURL) });
      if (matches(params.linkURL, CLAUDE_HOSTS)) items.push({ label: 'Open Link Here', click: () => contents.loadURL(params.linkURL) });
      items.push({ label: 'Copy Link', click: () => clipboard.writeText(params.linkURL) }, { type: 'separator' });
    }
    for (const s of params.dictionarySuggestions || []) items.push({ label: s, click: () => contents.replaceMisspelling(s) });
    if (params.dictionarySuggestions?.length) items.push({ type: 'separator' });
    if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' });
    else if (params.selectionText) items.push({ role: 'copy' });
    if (params.mediaType === 'image') items.push({ label: 'Copy Image', click: () => contents.copyImageAt(params.x, params.y) });
    items.push({ type: 'separator' }, { label: 'Inspect Element', click: () => contents.inspectElement(params.x, params.y) });
    Menu.buildFromTemplate(items).popup();
  });
}

function profileSession(p) {
  const ses = session.fromPartition(`persist:profile-${p.id}`);
  if (!sessionsReady.has(p.id)) {
    ses.setUserAgent(CHROME_UA);
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
    sessionsReady.add(p.id);
  }
  return ses;
}

function layout(w) {
  const { width, height } = w.win.getContentBounds();
  w.sidebar.setBounds({ x: 0, y: 0, width: SIDEBAR_WIDTH, height });
  for (const view of w.views.values()) view.setBounds({ x: SIDEBAR_WIDTH, y: 0, width: Math.max(0, width - SIDEBAR_WIDTH), height });
}

// A window loads a profile only when it is first shown there, so extra windows stay light.
function viewFor(w, id) {
  let view = w.views.get(id);
  if (view) return view;
  if (isPanel(id)) {
    view = new WebContentsView({ webPreferences: { preload: path.join(__dirname, PANELS[id].preload), sandbox: true, contextIsolation: true } });
    w.win.contentView.addChildView(view);
    w.views.set(id, view);
    layout(w);
    view.webContents.loadFile(path.join(__dirname, PANELS[id].page));
    return view;
  }
  const p = profile(id);
  view = new WebContentsView({
    webPreferences: { session: profileSession(p), sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: true },
  });
  guardContents(view.webContents);
  view.webContents.on('page-title-updated', () => { if (w.activeId === p.id) updateTitle(w); });
  w.win.contentView.addChildView(view);
  w.views.set(p.id, view);
  layout(w);
  view.webContents.loadURL(p.url);
  return view;
}

function dropView(w, id) {
  const view = w.views.get(id);
  if (!view) return;
  w.win.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
  w.views.delete(id);
}

function updateTitle(w) {
  if (isPanel(w.activeId)) { w.win.setTitle(PANELS[w.activeId].title); return; }
  const p = profile(w.activeId);
  const page = w.views.get(w.activeId)?.webContents.getTitle() || 'Claude';
  w.win.setTitle(`${p.name} · ${page}`);
}

// The app icon (Dock and ⌘Tab) takes on the active profile's icon, so the switcher shows which account
// you are about to land in.
function syncDockIcon(w) {
  const p = profile(w?.activeId);
  if (config.dockIconFollowsProfile === false || !p?.iconPath || process.platform !== 'darwin') return;
  const img = nativeImage.createFromPath(p.iconPath);
  if (!img.isEmpty()) app.dock.setIcon(img);
}

function select(w, id) {
  if (!w || w.win.isDestroyed() || (!isPanel(id) && !profile(id))) return;
  w.activeId = id;
  const view = viewFor(w, id);
  for (const [vid, v] of w.views) v.setVisible(vid === id);
  view.webContents.focus();
  updateTitle(w);
  if (w.win.isFocused()) syncDockIcon(w);
  w.sidebar.webContents.send('active', id);
  saveWindows();
}

// Open the Profiles screen with a blank "new profile" form.
function startNewProfile(w) {
  if (!w) return;
  select(w, PROFILES);
  const view = w.views.get(PROFILES);
  const send = () => view.webContents.send('editor-new');
  if (view.webContents.isLoading()) view.webContents.once('did-finish-load', send); else send();
}

function defaultScreen() { return config.profiles[0]?.id || PROFILES; }

function createWindow({ activeId, bounds } = {}) {
  const focused = focusedState();
  const win = new BaseWindow({
    width: bounds?.width || 1400,
    height: bounds?.height || 900,
    x: bounds?.x ?? (focused ? focused.win.getBounds().x + 30 : undefined),
    y: bounds?.y ?? (focused ? focused.win.getBounds().y + 30 : undefined),
    minWidth: 600,
    minHeight: 400,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 28, y: 18 },
    backgroundColor: '#ebe9e1',
  });
  const sidebar = new WebContentsView({
    webPreferences: { preload: path.join(__dirname, 'sidebar-preload.js'), sandbox: true, contextIsolation: true },
  });
  win.contentView.addChildView(sidebar);
  const w = { win, sidebar, views: new Map(), activeId: null };
  windows.set(win.id, w);
  layout(w);
  sidebar.webContents.loadFile(path.join(__dirname, 'sidebar.html'));
  win.on('resize', () => layout(w));
  win.on('focus', () => syncDockIcon(w));
  win.on('moved', saveWindows);
  win.on('closed', () => {
    // Forget the window first: if anything below throws, a destroyed window must not stay in the list.
    windows.delete(win.id);
    // A BaseWindow does not tear down its views' pages; close them or they keep running.
    for (const v of [sidebar, ...w.views.values()]) { try { if (!v.webContents.isDestroyed()) v.webContents.close(); } catch { /* already gone */ } }
    // Closing the last window keeps the saved layout, so the next launch brings it back.
    if (!app.isQuitting && windows.size) saveWindows();
  });
  sidebar.webContents.once('did-finish-load', () => {
    const first = isPanel(activeId) || profile(activeId) ? activeId : defaultScreen();
    if (!config.profiles.length) startNewProfile(w); else select(w, first);
    if (lastStatus) sidebar.webContents.send('status', lastStatus);
  });
  if (process.env.CLAUDE_PROFILES_DEBUG) {
    sidebar.webContents.on('console-message', (e) => console.log('[sidebar]', e.level, e.message));
    sidebar.webContents.on('preload-error', (_e, p, err) => console.log('[sidebar] preload error', p, err));
    const click = process.env.CLAUDE_PROFILES_DEBUG_CLICK;
    if (click) sidebar.webContents.once('did-finish-load', () => setTimeout(() => sidebar.webContents.executeJavaScript(`document.querySelector('[data-id="${click}"]')?.click()`), 3000));
    // Screenshots without screen-recording permission: the sidebar and the active view, as PNGs.
    const shot = process.env.CLAUDE_PROFILES_DEBUG_SHOT;
    // Run a script in the active view, to drive a screen in tests.
    const evalCode = process.env.CLAUDE_PROFILES_DEBUG_EVAL;
    if (evalCode) setTimeout(() => w.views.get(w.activeId)?.webContents.executeJavaScript(evalCode).then((r) => console.log('[eval] result', r), (e) => console.log('[eval] error', e.message)), 4000);
    if (shot) win.setVisibleOnAllWorkspaces(true); // a window on another desktop never paints
    if (shot) setTimeout(async () => {
      fs.writeFileSync(`${shot}-sidebar.png`, (await sidebar.webContents.capturePage()).toPNG());
      const active = w.views.get(w.activeId);
      if (active) fs.writeFileSync(`${shot}-content.png`, (await active.webContents.capturePage()).toPNG());
    }, Number(process.env.CLAUDE_PROFILES_DEBUG_SHOT_DELAY || 7000));
  }
  return w;
}

function focusedState() {
  const win = BaseWindow.getFocusedWindow();
  return (win && windows.get(win.id)) || [...windows.values()].at(-1) || null;
}
const activeContents = () => {
  const w = focusedState();
  return w?.views.get(w.activeId)?.webContents;
};

// Re-read profiles.json after the Profiles screen (or a hand edit) changes it, without a restart.
function reloadConfig() {
  config = loadConfig();
  buildMenu();
  for (const w of windows.values()) {
    for (const id of [...w.views.keys()]) if (!isPanel(id) && !profile(id)) dropView(w, id);
    if (!isPanel(w.activeId) && !profile(w.activeId)) select(w, defaultScreen());
    else updateTitle(w);
    if (!w.sidebar.webContents.isDestroyed()) w.sidebar.webContents.send('profiles-changed');
  }
  syncDockIcon(focusedState());
  pushStatus();
}

function buildMenu() {
  const step = (dir) => {
    const w = focusedState();
    if (!w || !config.profiles.length) return;
    const i = config.profiles.findIndex((p) => p.id === w.activeId);
    select(w, config.profiles[(i + dir + config.profiles.length) % config.profiles.length].id);
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => createWindow({ activeId: focusedState()?.activeId }) },
        {
          label: 'New Window For',
          enabled: config.profiles.length > 0,
          submenu: config.profiles.map((p, i) => ({
            label: p.name,
            accelerator: i < 9 ? `CmdOrCtrl+Shift+${i + 1}` : undefined,
            click: () => createWindow({ activeId: p.id }),
          })),
        },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => activeContents()?.reload() },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => activeContents()?.navigationHistory.goBack() },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => activeContents()?.navigationHistory.goForward() },
        { label: 'Claude Code Home', accelerator: 'CmdOrCtrl+Shift+H', click: () => { const w = focusedState(); if (w && profile(w.activeId)) activeContents()?.loadURL(profile(w.activeId).url); } },
        { type: 'separator' },
        { label: 'Open Page in Browser', accelerator: 'CmdOrCtrl+Shift+O', click: () => { const c = activeContents(); if (c && isWeb(c.getURL())) openExternal(c.getURL()); } },
        { label: 'Copy Page Link', accelerator: 'CmdOrCtrl+Shift+C', click: () => { const c = activeContents(); if (c) clipboard.writeText(c.getURL()); } },
        // For sign-in links that arrive by email, and Claude links from elsewhere: copy, then open in the right profile.
        { label: 'Open Copied Link in This Profile', accelerator: 'CmdOrCtrl+Shift+V', click: () => { const w = focusedState(); const u = clipboard.readText().trim(); if (w && profile(w.activeId) && isWeb(u)) activeContents()?.loadURL(u); } },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
        { type: 'separator' },
        { label: 'Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => activeContents()?.toggleDevTools() },
      ],
    },
    {
      label: 'Profiles',
      submenu: [
        ...config.profiles.map((p, i) => ({
          label: `${p.name}${p.account ? ` (${p.account})` : ''}`,
          accelerator: i < 9 ? `CmdOrCtrl+${i + 1}` : undefined,
          click: () => select(focusedState(), p.id),
        })),
        ...(config.profiles.length ? [{ type: 'separator' }] : []),
        { label: 'Next Profile', accelerator: 'Ctrl+Tab', click: () => step(1) },
        { label: 'Previous Profile', accelerator: 'Ctrl+Shift+Tab', click: () => step(-1) },
        { type: 'separator' },
        { label: 'Add Profile…', click: () => startNewProfile(focusedState()) },
        { label: 'Manage Profiles', accelerator: 'CmdOrCtrl+,', click: () => select(focusedState(), PROFILES) },
        { label: 'Servers', accelerator: 'CmdOrCtrl+Shift+S', click: () => select(focusedState(), SERVERS) },
        { type: 'separator' },
        { label: 'Show Data Folder', click: () => shell.openPath(CONFIG_DIR) },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

ipcMain.handle('profiles', () => config.profiles.map((p) => {
  const img = p.iconPath ? nativeImage.createFromPath(p.iconPath) : null;
  return { id: p.id, name: p.name, account: p.account || '', icon: img && !img.isEmpty() ? img.resize({ width: 96 }).toDataURL() : null };
}));
ipcMain.on('select', (event, id) => {
  const w = [...windows.values()].find((x) => x.sidebar.webContents === event.sender);
  if (id === 'new') startNewProfile(w); else select(w, id);
});

// Server status for the sidebar badges: per profile, whether its servers run here, from a Terminal, or not at all.
let lastStatus = null;
async function pushStatus(known) {
  try {
    const st = known || await mgr.status();
    const byProfile = {};
    for (const s of st.servers) {
      const b = (byProfile[s.profileId] ||= { state: 'stopped', sessions: 0, problem: false });
      b.sessions += s.sessions.length + s.terminal.reduce((a, t) => a + t.sessions.length, 0);
      if (s.problem) b.problem = true;
      if (s.pid) b.state = 'running';
      else if (s.terminal.length && b.state === 'stopped') b.state = 'terminal';
    }
    lastStatus = byProfile;
    for (const w of windows.values()) if (!w.sidebar.webContents.isDestroyed()) w.sidebar.webContents.send('status', byProfile);
  } catch { /* status is best effort */ }
}

// Only the app's own screens may call these; profile pages have no preload and cannot reach IPC at all.
function fromPanel(event, id) {
  return [...windows.values()].find((w) => w.views.get(id)?.webContents === event.sender) || null;
}

ipcMain.handle('mgr', async (event, action, ...args) => {
  if (!fromPanel(event, SERVERS)) throw new Error('not allowed');
  const actions = {
    status: async () => { const st = await mgr.status(); pushStatus(st); return st; },
    start: (key) => mgr.startServer(key),
    stop: (key) => mgr.stopServer(key),
    restart: async (key) => { await mgr.stopServer(key); await mgr.startServer(key); },
    endSession: (pid) => mgr.endSession(Number(pid)),
    stopUnmanaged: (pid) => mgr.stopUnmanagedServer(Number(pid)),
    keep: (id, on) => mgr.setKeep(id, on),
    setCleanup: (on) => mgr.setCleanup(on),
    reap: (dryRun) => mgr.reap({ dryRun: !!dryRun }),
    openConfig: () => select(fromPanel(event, SERVERS), PROFILES),
    packaged: () => app.isPackaged,
  };
  if (!actions[action]) throw new Error(`unknown action ${action}`);
  const result = await actions[action](...args);
  if (action !== 'status' && action !== 'packaged') setTimeout(pushStatus, 1500);
  return result;
});

// ---- Profiles screen -------------------------------------------------------------------------------

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const appleString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

// Run a setup command in a new Terminal window; if the app may not drive Terminal, copy it instead.
function runInTerminal(command) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', 'tell application "Terminal" to activate', '-e', `tell application "Terminal" to do script ${appleString(command)}`], (err) => {
      if (!err) return resolve({ ran: true, command });
      clipboard.writeText(command);
      resolve({ ran: false, copied: true, command });
    });
  });
}

function iconData(p) {
  if (!p.icon) return null;
  const img = nativeImage.createFromPath(path.resolve(CONFIG_DIR, P.expand(p.icon)));
  return img.isEmpty() ? null : img.resize({ width: 96 }).toDataURL();
}

// Signed in on the web = the profile's session holds claude.ai's sessionKey cookie (presence only; never read).
async function webSignedIn(id) {
  try { return (await session.fromPartition(`persist:profile-${id}`).cookies.get({ url: 'https://claude.ai', name: 'sessionKey' })).length > 0; } catch { return false; }
}

async function describeProfiles() {
  const raw = P.readRaw(CONFIG_DIR);
  return Promise.all(raw.profiles.map(async (p) => {
    const cfg = P.expand(p.configDir || '');
    const cli = cfg ? mgr.claudeConfig(cfg) : { account: null, remoteAccepted: false };
    return {
      id: p.id, name: p.name, account: p.account || '', url: p.url || P.DEFAULT_URL, configDir: p.configDir || '', icon: iconData(p),
      webSignedIn: await webSignedIn(p.id), cliAccount: cli.account, remoteAccepted: cli.remoteAccepted,
      folders: (p.servers || []).map((s) => ({ folder: P.expand(s.folder), display: s.folder, key: `${p.id}-${s.id}`, trusted: cfg ? mgr.claudeConfig(cfg, P.expand(s.folder)).trusted : false })),
    };
  }));
}

ipcMain.handle('editor', async (event, action, ...args) => {
  const w = fromPanel(event, PROFILES);
  if (!w) throw new Error('not allowed');
  const pick = (options) => dialog.showOpenDialog(w.win, options).then((r) => (r.canceled ? [] : r.filePaths));
  const actions = {
    list: async () => ({ profiles: await describeProfiles(), home: require('node:os').homedir() }),
    chooseFolders: () => pick({ title: 'Choose working folders', properties: ['openDirectory', 'multiSelections', 'createDirectory'] }),
    chooseConfigDir: () => pick({ title: 'Choose a Claude config folder', properties: ['openDirectory', 'showHiddenFiles', 'createDirectory'], defaultPath: require('node:os').homedir() }).then((r) => r[0] || null),
    chooseIcon: async () => {
      const [file] = await pick({ title: 'Choose an icon', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'icns', 'heic', 'webp', 'gif', 'tiff'] }] });
      if (!file) return null;
      const img = nativeImage.createFromPath(file);
      if (img.isEmpty()) throw new Error('That file could not be read as an image.');
      return { source: file, preview: img.resize({ width: 96 }).toDataURL() };
    },
    save: (input) => {
      const saved = P.upsertProfile(CONFIG_DIR, { ...input, icon: input.removeIcon ? '' : undefined });
      if (input.iconSource || input.iconDataUrl) {
        if (input.iconDataUrl && !/^data:image\/png;base64,/.test(input.iconDataUrl)) throw new Error('Unexpected icon data.');
        const img = input.iconSource ? nativeImage.createFromPath(input.iconSource) : nativeImage.createFromDataURL(input.iconDataUrl);
        if (img.isEmpty()) throw new Error('That file could not be read as an image.');
        fs.mkdirSync(path.join(CONFIG_DIR, 'icons'), { recursive: true });
        fs.writeFileSync(path.join(CONFIG_DIR, 'icons', `${saved.id}.png`), img.resize({ width: 256, height: 256 }).toPNG());
        const raw = P.readRaw(CONFIG_DIR);
        raw.profiles.find((p) => p.id === saved.id).icon = `icons/${saved.id}.png`;
        P.writeRaw(CONFIG_DIR, raw);
      }
      reloadConfig();
      return saved.id;
    },
    remove: async (id) => {
      const p = P.readRaw(CONFIG_DIR).profiles.find((x) => x.id === id);
      for (const s of p?.servers || []) await mgr.stopServer(`${id}-${s.id}`).catch(() => {});
      P.removeProfile(CONFIG_DIR, id);
      reloadConfig();
    },
    cliLogin: async (id) => {
      const p = (await describeProfiles()).find((x) => x.id === id);
      return runInTerminal(`CLAUDE_CONFIG_DIR=${shq(P.expand(p.configDir))} claude`);
    },
    trustFolder: async (id, folder) => {
      const p = (await describeProfiles()).find((x) => x.id === id);
      return runInTerminal(`cd ${shq(folder)} && CLAUDE_CONFIG_DIR=${shq(P.expand(p.configDir))} claude remote-control`);
    },
    openProfile: (id) => select(w, id),
    openServers: () => select(w, SERVERS),
  };
  if (!actions[action]) throw new Error(`unknown action ${action}`);
  return actions[action](...args);
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = focusedState();
    if (w) { if (w.win.isMinimized()) w.win.restore(); w.win.focus(); } else createWindow();
  });
  app.userAgentFallback = CHROME_UA;
  app.on('before-quit', () => { saveWindows(); app.isQuitting = true; });
  app.whenReady().then(() => {
    try {
      config = loadConfig();
    } catch (err) {
      dialog.showErrorBox('Claude Profiles', `Could not read profiles.json in ${CONFIG_DIR}:\n\n${err.message}`);
      app.quit();
      return;
    }
    buildMenu();
    const saved = readState().windows;
    if (Array.isArray(saved) && saved.length) for (const s of saved) createWindow(s);
    else createWindow();
    pushStatus();
    setInterval(pushStatus, 30000);
  });
  // Clicking the Dock icon with every window closed opens a fresh one.
  app.on('activate', () => { if (!windows.size) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
