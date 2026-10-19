// Claude Profiles: windows with a sidebar of Claude accounts, each signed in inside its own isolated
// browser session (cookies, storage and cache never cross between profiles).
//
// Every window is independent: its own sidebar and active profile, so windows can sit on different
// macOS desktops, including several on the same account (they share that account's sign-in).
// Profiles live in profiles.json in the app's data folder and are created and edited on the Profiles
// screen. The Servers screen manages each profile's Claude Code Remote Control servers (manager.js);
// the servers are launchd jobs running this app's own helper, so they keep going when the app quits.
// Links to anything outside Claude open in the default browser; Claude links stay in the profile.

const { app, BaseWindow, BrowserWindow, WebContentsView, ipcMain, shell, session, Menu, nativeImage, clipboard, dialog } = require('electron');
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
// claude.site and claudeusercontent.com serve artifacts and Claude Design previews.
const CLAUDE_HOSTS = [/(^|\.)claude\.ai$/, /(^|\.)claude\.com$/, /(^|\.)anthropic\.com$/, /(^|\.)claude\.site$/, /(^|\.)claudeusercontent\.com$/];
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
    p.kind ||= 'code';
    p.url ||= (P.KINDS[p.kind] || P.KINDS.code).url;
    p.iconPath = p.icon ? path.resolve(CONFIG_DIR, P.expand(p.icon)) : null;
  }
  // A profile may borrow another's sign-in; ignore a link to a profile that no longer exists.
  for (const p of raw.profiles) if (p.shareSignIn && !ids.has(p.shareSignIn)) delete p.shareSignIn;
  return raw;
}

// The browser session a profile uses: its own, or the one it shares with another profile.
const signInId = (p) => p.shareSignIn || p.id;

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
  const sid = signInId(p);
  const ses = session.fromPartition(`persist:profile-${sid}`);
  if (!sessionsReady.has(sid)) {
    if (process.env.CLAUDE_PROFILES_DEBUG_NET) ses.webRequest.onCompleted({ urls: ['https://claude.ai/*', 'https://api.anthropic.com/*'] }, (d) => { if (/session|code/i.test(d.url) && !/\.(js|css|woff2?|png|svg)(\?|$)/.test(d.url)) console.log('[net]', d.method, d.statusCode, d.url.slice(0, 160)); });
    ses.setUserAgent(CHROME_UA);
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(ALLOWED_PERMISSIONS.has(permission)));
    ses.setPermissionCheckHandler((_wc, permission) => ALLOWED_PERMISSIONS.has(permission));
    sessionsReady.add(sid);
  }
  return ses;
}

function layout(w) {
  if (w.win.isDestroyed()) return;
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
  view.webContents.on('did-navigate', () => continueIfStranded(view.webContents, p));
  view.webContents.on('did-navigate-in-page', () => continueIfStranded(view.webContents, p));
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
  if (w.win.isDestroyed()) return;
  if (isPanel(w.activeId)) { w.win.setTitle(PANELS[w.activeId].title); return; }
  const p = profile(w.activeId);
  const page = w.views.get(w.activeId)?.webContents.getTitle() || 'Claude';
  w.win.setTitle(`${p.name} · ${page}`);
}

// macOS draws app icons on a grid: the visible tile is 824 of 1024 px (about 80%), centred in transparent
// margins. A profile icon that fills its whole image (the generated colour tiles, most pictures) would look
// oversized next to other apps in the Dock and ⌘Tab, so give it those margins. Icons that already have
// transparent margins (such as ones taken from other Mac apps) are used as they are.
function dockImage(img) {
  const probe = img.resize({ width: 64, height: 64 }).toBitmap();
  const alpha = (x, y) => probe[(y * 64 + x) * 4 + 3];
  if (alpha(32, 1) < 16 && alpha(1, 32) < 16 && alpha(32, 62) < 16) return img;
  const size = 512;
  const inner = Math.round((size * 824) / 1024);
  const offset = Math.round((size - inner) / 2);
  const src = img.resize({ width: inner, height: inner, quality: 'best' }).toBitmap();
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < inner; y++) src.copy(out, ((y + offset) * size + offset) * 4, y * inner * 4, (y + 1) * inner * 4);
  return nativeImage.createFromBitmap(out, { width: size, height: size });
}
const dockImages = new Map(); // iconPath -> padded image, so switching profiles does no image work twice

// The app icon (Dock and ⌘Tab) takes on the active profile's icon, so the switcher shows which account
// you are about to land in.
function syncDockIcon(w) {
  if (!w || w.win.isDestroyed()) return;
  const p = profile(w?.activeId);
  if (config.dockIconFollowsProfile === false || !p?.iconPath || process.platform !== 'darwin') return;
  if (!dockImages.has(p.iconPath)) {
    const img = nativeImage.createFromPath(p.iconPath);
    dockImages.set(p.iconPath, img.isEmpty() ? null : dockImage(img));
  }
  const img = dockImages.get(p.iconPath);
  if (img) app.dock.setIcon(img);
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
  if (profile(id)) continueIfStranded(view.webContents, profile(id));
}

// Opening a Remote Control session that no server can reach any more (its server restarted into a new
// environment) carries it on as a new session from its transcript and shows that instead.
const continuing = new Map(); // session ID -> time of the last attempt
async function continueIfStranded(contents, p) {
  const m = contents.getURL().match(/^https:\/\/claude\.ai\/code\/(?:session_|cse_)([A-Za-z0-9]+)/);
  if (!m) return;
  const id = `cse_${m[1]}`;
  if (Date.now() - (continuing.get(id) || 0) < 120000) return;
  continuing.set(id, Date.now());
  try {
    const r = await session.fromPartition(`persist:profile-${signInId(p)}`).fetch('https://claude.ai/v1/code/sessions?statuses=active&statuses=paused&limit=100', {
      credentials: 'include',
      headers: { 'anthropic-version': '2023-06-01', 'anthropic-client-platform': 'web_claude_ai' },
    });
    const record = r.ok ? ((await r.json()).data || []).find((x) => x.id === id) : null;
    if (!record) return;
    // IDs of the session's latest messages, to find a transcript the CLI did not name after the session.
    const messageIds = async () => {
      const e = await session.fromPartition(`persist:profile-${signInId(p)}`).fetch(`https://claude.ai/v1/code/sessions/session_${m[1]}/events?limit=50&sort_order=desc`, {
        credentials: 'include',
        headers: { 'anthropic-version': '2023-06-01', 'anthropic-client-platform': 'web_claude_ai' },
      });
      if (!e.ok) return [];
      return ((await e.json()).data || []).filter((x) => x.event_type === 'user' || x.event_type === 'assistant').map((x) => x.payload?.uuid).filter(Boolean);
    };
    const result = await mgr.continueSession([p.id, signInId(p)], record, { messageIds });
    if (!result.sessionId) return;
    console.log(`[continue] ${id} -> ${result.sessionId}`);
    // Only move the view if it is still on the stranded session.
    if (!contents.isDestroyed() && contents.getURL().includes(m[1])) contents.loadURL(`https://claude.ai/code/${result.sessionId.replace(/^cse_/, 'session_')}`);
    setTimeout(pushStatus, 1500);
  } catch (e) {
    console.log('[continue] failed', id, e.message);
  }
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
  // All teardown happens in 'close'. A BaseWindow holding WebContentsViews is destroyed without ever
  // emitting 'closed' (seen on Electron 43), so cleanup placed there never ran: the dead window stayed
  // in `windows` with live pages, later layout saves threw "Object has been destroyed", status pushes to
  // its views crashed the app (EXC_BAD_ACCESS), and the saved layout reopened the closed window.
  let tornDown = false;
  const teardown = () => {
    if (tornDown) return;
    tornDown = true;
    windows.delete(win.id);
    // Late resize/move/focus events from a closing window must not reach code that reads it.
    win.removeAllListeners('resize');
    win.removeAllListeners('moved');
    win.removeAllListeners('focus');
    // A BaseWindow does not close its views' pages; detach each view while the window exists, then close it.
    for (const v of [sidebar, ...w.views.values()]) {
      try { win.contentView.removeChildView(v); } catch { /* not attached */ }
      try { if (!v.webContents.isDestroyed()) v.webContents.close(); } catch { /* already gone */ }
    }
    // Closing the last window keeps the saved layout, so the next launch brings it back.
    if (!app.isQuitting && windows.size) saveWindows();
  };
  win.on('close', teardown);
  win.on('closed', teardown);
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
    // Quit after a delay with every window open, to test teardown on quit.
    if (process.env.CLAUDE_PROFILES_DEBUG_QUIT && windows.size === 1) setTimeout(() => { console.log('[debug] quitting'); app.quit(); }, 8000);
    // Close this window after a delay, to test window teardown.
    if (process.env.CLAUDE_PROFILES_DEBUG_CLOSE_FIRST && windows.size === 1) setTimeout(() => { console.log('[debug] closing first window'); win.close(); setTimeout(() => console.log('[debug] after close: destroyed', win.isDestroyed(), 'visible', !win.isDestroyed() && win.isVisible()), 2000); }, 6000);
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
        { label: 'Profile Home', accelerator: 'CmdOrCtrl+Shift+H', click: () => { const w = focusedState(); if (w && profile(w.activeId)) activeContents()?.loadURL(profile(w.activeId).url); } },
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

// Session titles, as shown in claude.ai's own sidebar, fetched with each profile's sign-in. This is
// claude.ai's internal web API, not a documented one: on any failure the Servers screen falls back to IDs.
const titleCache = new Map(); // profileId -> { at, map: Map<sessionId, { title, lastEventAt }> }
async function sessionTitles(profileId) {
  const cached = titleCache.get(profileId);
  if (cached && Date.now() - cached.at < 60000) return cached.map;
  const map = new Map();
  try {
    const r = await session.fromPartition(`persist:profile-${profileId}`).fetch('https://claude.ai/v1/code/sessions?statuses=active&statuses=paused&limit=50', {
      credentials: 'include',
      headers: { 'anthropic-version': '2023-06-01', 'anthropic-client-platform': 'web_claude_ai' },
    });
    if (r.ok) for (const s of (await r.json()).data || []) map.set(s.id, { title: s.title || null, lastEventAt: s.last_event_at || null });
  } catch { /* signed out or offline: no titles */ }
  titleCache.set(profileId, { at: Date.now(), map });
  return map;
}
async function withTitles(st) {
  const maps = Object.fromEntries(await Promise.all(config.profiles.filter((p) => !p.shareSignIn).map(async (p) => [p.id, await sessionTitles(p.id)])));
  const find = (sid, prefer) => (prefer && maps[prefer]?.get(sid)) || Object.values(maps).map((m) => m.get(sid)).find(Boolean);
  const enrich = (list, prefer) => { for (const s of list) { const t = find(s.sessionId, prefer); if (t) Object.assign(s, t); } };
  for (const s of st.servers) { enrich(s.sessions, s.profileId); for (const t of s.terminal) enrich(t.sessions, s.profileId); }
  for (const u of st.unmanaged) enrich(u.sessions);
  return st;
}

// Only the app's own screens may call these; profile pages have no preload and cannot reach IPC at all.
function fromPanel(event, id) {
  return [...windows.values()].find((w) => w.views.get(id)?.webContents === event.sender) || null;
}

ipcMain.handle('mgr', async (event, action, ...args) => {
  if (!fromPanel(event, SERVERS)) throw new Error('not allowed');
  const actions = {
    status: async () => { const st = await mgr.status(); pushStatus(st); return withTitles(st); },
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
  if (action === 'start' || action === 'restart') setTimeout(retireStaleEnvironments, 60000);
  return result;
});

const retiredFile = () => path.join(CONFIG_DIR, 'state', 'retired-environments.json');
const readJsonFile = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
function writeJsonFile(f, value) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(value, null, 2)); }

// Stars and new-session defaults on claude.ai name an environment, not a folder. The picker opens new
// sessions on the first starred environment, and falls back to the cloud when that one is gone. So when a
// dead environment is archived, its star and defaults move to the folder's live one, in the same place.
// claude.ai saves these as JSON strings in its Claude Code settings; a PUT carries only changed entries.
// New sessions open where the composer was last pointed, which claude.ai keeps in the browser's
// localStorage (ccd-session-store). Pointed at a dead environment, the folder reads "offline"; once that
// environment is archived, the page falls back to the cloud and remembers that instead.
const COMPOSER = 'ccd-session-store';
async function pointComposerAtLive(p, replaced) {
  // A claude.ai page that does not start the web app, so no running copy of the store writes over this.
  const w = new BrowserWindow({ show: false, webPreferences: { session: profileSession(p), sandbox: true, contextIsolation: true } });
  let moved = null;
  try {
    for (let i = 0; i < 3; i++) {
      await w.loadURL('https://claude.ai/robots.txt').catch(() => {});
      if (w.webContents.getURL().startsWith('https://claude.ai/')) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!w.webContents.getURL().startsWith('https://claude.ai/')) throw new Error('could not open a claude.ai page');
    moved = await w.webContents.executeJavaScript(`(() => {
      const raw = localStorage.getItem(${JSON.stringify(COMPOSER)});
      if (!raw) return null;
      const v = JSON.parse(raw);
      const live = (${JSON.stringify(replaced)})[v.state?.worker?.id];
      if (!live) return null;
      v.state.worker = { type: 'environment', id: live };
      v.state.currentHostKey = 'bridge';
      localStorage.setItem(${JSON.stringify(COMPOSER)}, JSON.stringify(v));
      return live;
    })()`);
  } catch (e) {
    mgr.log(`could not repoint new sessions in ${p.name}: ${e.message}`);
  } finally {
    if (!w.isDestroyed()) w.destroy();
  }
  if (!moved) return;
  mgr.log(`new sessions in ${p.name} now open on ${moved}`);
  // A new-session screen already open still holds the old choice: reload it so it reads the new one.
  for (const win of windows.values()) {
    const view = win.views.get(p.id);
    if (view && !view.webContents.isDestroyed() && /^https:\/\/claude\.ai\/code\/?(\?.*)?$/.test(view.webContents.getURL())) view.webContents.reload();
  }
}

const STARRED = 'ccd/epitaxy-starred-environments';
const PRESETS = 'ccd/session-presets';
async function carrySettings(ses, org, replaced, profileName) {
  const url = `https://claude.ai/api/claude_code/organizations/${org}/user_settings`;
  const r = await ses.fetch(url, { credentials: 'include' });
  if (!r.ok) return;
  const entries = (await r.json()).content?.entries || {};
  const changed = {};
  const parse = (k) => { try { return entries[k] ? JSON.parse(entries[k]) : null; } catch { return null; } };
  const starred = parse(STARRED);
  if (Array.isArray(starred?.state?.starredIds)) {
    const ids = starred.state.starredIds;
    const next = [...new Set(ids.map((id) => { const m = id.match(/^bridge:(.+)$/); return m && replaced[m[1]] ? `bridge:${replaced[m[1]]}` : id; }))];
    if (JSON.stringify(next) !== JSON.stringify(ids)) changed[STARRED] = JSON.stringify({ ...starred, state: { ...starred.state, starredIds: next }, updatedAt: Date.now() });
  }
  const presets = parse(PRESETS);
  const places = presets?.state?.placeDefaults;
  if (places && typeof places === 'object') {
    const next = { ...places };
    for (const [dead, live] of Object.entries(replaced)) {
      if (!next[`bridge:${dead}`]) continue;
      next[`bridge:${live}`] ??= next[`bridge:${dead}`];
      delete next[`bridge:${dead}`];
    }
    if (JSON.stringify(next) !== JSON.stringify(places)) changed[PRESETS] = JSON.stringify({ ...presets, state: { ...presets.state, placeDefaults: next }, updatedAt: Date.now() });
  }
  if (!Object.keys(changed).length) return;
  const w = await ses.fetch(url, { method: 'PUT', credentials: 'include', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entries: changed }) });
  mgr.log(`${w.ok ? 'moved' : `could not move (${w.status})`} starred environments and defaults to the live environment in ${profileName}`);
}

// claude.ai's new-session picker shows one entry per folder and can pick an environment no server serves
// any more, so the folder looks offline while its server is running. Each server start used to leave one
// behind. Once a folder's server is online, archive this Mac's other environments for that folder.
// Archiving hides only the environment: its sessions stay listed, and opening one continues it.
async function retireStaleEnvironments() {
  let st;
  try { st = await mgr.status(); } catch { return; }
  const machine = require('node:os').hostname().replace(/\.local$/, '');
  const headers = { 'anthropic-version': '2023-06-01', 'anthropic-client-platform': 'web_claude_ai' };
  for (const p of config.profiles.filter((x) => !x.shareSignIn)) {
    const folders = new Set(st.servers.filter((s) => s.profileId === p.id && s.pid).map((s) => s.folder));
    if (!folders.size) continue;
    const ses = session.fromPartition(`persist:profile-${p.id}`);
    try {
      const orgs = await (await ses.fetch('https://claude.ai/api/organizations', { credentials: 'include' })).json();
      for (const org of Array.isArray(orgs) ? orgs : []) {
        const base = `https://claude.ai/v1/environment_providers/private/organizations/${org.uuid}/environments`;
        const r = await ses.fetch(`${base}?limit=1000`, { credentials: 'include', headers });
        if (!r.ok) continue;
        const ours = ((await r.json()).environments || []).filter((e) => e.kind === 'bridge' && e.state === 'active' && e.bridge_info?.machine_name === machine);
        const retired = readJsonFile(retiredFile(), {});
        const replaced = {}; // dead environment ID -> the live one for its folder
        const live = {};
        for (const folder of folders) {
          const here = ours.filter((e) => e.bridge_info.directory === folder);
          live[folder] = here.find((e) => e.bridge_info.online);
          if (!live[folder]) continue;
          for (const e of here.filter((x) => !x.bridge_info.online)) replaced[e.environment_id] = live[folder].environment_id;
          for (const [id, r] of Object.entries(retired)) if (r.profileId === p.id && r.folder === folder) replaced[id] = live[folder].environment_id;
        }
        // First, while claude.ai still lists the dead environment: once it is gone, the page falls back
        // to the cloud and saves that as the place new sessions open.
        if (Object.keys(replaced).length) await pointComposerAtLive(p, replaced);
        for (const folder of folders) {
          if (!live[folder]) continue;
          const here = ours.filter((e) => e.bridge_info.directory === folder);
          for (const e of here.filter((x) => !x.bridge_info.online)) {
            const a = await ses.fetch(`${base}/${e.environment_id}/archive`, { method: 'POST', credentials: 'include', headers });
            mgr.log(`${a.ok ? 'archived' : `could not archive (${a.status})`} stale environment ${e.environment_id} for ${folder} in ${p.name}`);
            if (a.ok) retired[e.environment_id] = { profileId: p.id, folder, at: new Date().toISOString() };
          }
        }
        writeJsonFile(retiredFile(), retired);
        if (Object.keys(replaced).length) await carrySettings(ses, org.uuid, replaced, p.name);
      }
    } catch (e) { mgr.log(`retiring stale environments in ${p.name}: ${e.message}`); }
  }
}

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
      id: p.id, kind: p.kind || 'code', name: p.name, account: p.account || '', url: p.url || (P.KINDS[p.kind] || P.KINDS.code).url, configDir: p.configDir || '', icon: iconData(p),
      shareSignIn: p.shareSignIn || null, shareName: p.shareSignIn ? raw.profiles.find((x) => x.id === p.shareSignIn)?.name || null : null,
      webSignedIn: await webSignedIn(p.shareSignIn || p.id), cliAccount: cli.account, remoteAccepted: cli.remoteAccepted,
      folders: (p.servers || []).map((s) => ({ folder: P.expand(s.folder), display: s.folder, key: `${p.id}-${s.id}`, trusted: cfg ? mgr.claudeConfig(cfg, P.expand(s.folder)).trusted : false })),
    };
  }));
}

// Optional custom marks: marks/<kind>.svg in the data folder replaces the built-in mark for that profile type.
// Kept out of the repo on purpose, so people can use artwork they may not redistribute.
function customMarks() {
  const out = {};
  for (const kind of Object.keys(P.KINDS)) {
    try {
      const svg = fs.readFileSync(path.join(CONFIG_DIR, 'marks', `${kind}.svg`), 'utf8');
      const open = svg.match(/<svg\b[^>]*>/i);
      const viewBox = open && (open[0].match(/viewBox="([^"]+)"/i) || [])[1];
      const inner = open && svg.slice(svg.indexOf(open[0]) + open[0].length, svg.lastIndexOf('</svg>'));
      if (viewBox && inner) out[kind] = { viewBox, inner: inner.replace(/<script[\s\S]*?<\/script>/gi, '') };
    } catch { /* no custom mark */ }
  }
  return out;
}

ipcMain.handle('editor', async (event, action, ...args) => {
  const w = fromPanel(event, PROFILES);
  if (!w) throw new Error('not allowed');
  const pick = (options) => dialog.showOpenDialog(w.win, options).then((r) => (r.canceled ? [] : r.filePaths));
  const actions = {
    list: async () => ({ profiles: await describeProfiles(), home: require('node:os').homedir(), marks: customMarks() }),
    chooseFolders: () => pick({ title: 'Choose working folders', properties: ['openDirectory', 'multiSelections', 'createDirectory'] }),
    chooseConfigDir: () => pick({ title: 'Choose a Claude config folder', properties: ['openDirectory', 'showHiddenFiles', 'createDirectory'], defaultPath: require('node:os').homedir() }).then((r) => r[0] || null),
    chooseIcon: async () => {
      const [file] = await pick({ title: 'Choose an icon', properties: ['openFile'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'icns', 'heic', 'webp', 'gif', 'tiff'] }] });
      if (!file) return null;
      const img = nativeImage.createFromPath(file);
      if (img.isEmpty()) throw new Error('That file could not be read as an image.');
      return { source: file, preview: img.resize({ width: 96 }).toDataURL() };
    },
    save: async (input) => {
      // Servers for folders the profile no longer has (removed, or the profile became Design) are stopped,
      // so no launchd job keeps running, or retrying, for a folder that has left profiles.json.
      const serverKeys = (id) => (P.readRaw(CONFIG_DIR).profiles.find((p) => p.id === id)?.servers || []).map((sv) => `${id}-${sv.id}`);
      const before = input.id ? serverKeys(input.id) : [];
      const saved = P.upsertProfile(CONFIG_DIR, { ...input, icon: input.removeIcon ? '' : undefined });
      const after = new Set(serverKeys(saved.id));
      for (const key of before) if (!after.has(key)) await mgr.stopServer(key).catch(() => {});
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
    setTimeout(retireStaleEnvironments, 60000);
    setInterval(retireStaleEnvironments, 30 * 60000);
  });
  // Clicking the Dock icon with every window closed opens a fresh one.
  app.on('activate', () => { if (!windows.size) createWindow(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}
