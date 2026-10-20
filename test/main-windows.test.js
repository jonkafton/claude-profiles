'use strict';
const { sb, fe, mgr, callsOf, loadMain, settle } = require('./helpers/main-fixture');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORK = { id: 'work', name: 'Work', account: 'alice@example.com', configDir: '~/.claude-work', icon: 'icons/work.png', servers: [] };
const HOME = { id: 'home', name: 'Home', account: 'alice@home.example', url: 'https://claude.ai/code/pinned' };
const DESIGN = { id: 'work-design', kind: 'design', name: 'Work Design', account: 'alice@example.com', shareSignIn: 'work' };
const PROFILES = [WORK, HOME, DESIGN];

describe('startup', () => {
  test('opens one window on the first profile when no layout was saved', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    assert.equal(h.appWindows().length, 1);
    const w = h.win();
    const sidebar = h.sidebarOf(w);
    assert.match(sidebar.webContents.file, /sidebar\.html$/);
    assert.match(sidebar.webPreferences.preload, /sidebar-preload\.js$/);
    assert.equal(sidebar.webPreferences.sandbox, true);
    assert.equal(sidebar.webPreferences.contextIsolation, true);
    assert.equal(h.activeId(w), 'work');
    const view = h.viewFor(w, 'work');
    assert.deepEqual(view.webContents.loads, ['https://claude.ai/code']);
    assert.equal(w.title, 'Work · Claude');
    assert.ok(fe.state.appMenu, 'the app menu is set');
    assert.ok(callsOf('status').length >= 1, 'server status is fetched at startup');
  });
  test('passes the helper path and app binary to the manager', async (t) => {
    await loadMain(t, { profiles: PROFILES });
    assert.equal(mgr.opts.appBinary, process.execPath);
    assert.equal(mgr.opts.helperPath, path.join(__dirname, '..', 'helper.js'));
    assert.equal(mgr.opts.configDir, process.env.CLAUDE_PROFILES_DIR);
  });
  test('restores every saved window with its bounds and screen', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES, saved: { windows: [
      { bounds: { x: 10, y: 20, width: 1000, height: 700 }, activeId: 'home' },
      { bounds: { x: 50, y: 60, width: 900, height: 650 }, activeId: '__servers' },
      { bounds: { x: 0, y: 0, width: 800, height: 600 }, activeId: 'deleted-profile' },
    ] } });
    const [a, b, c] = h.appWindows();
    assert.deepEqual(a.bounds, { x: 10, y: 20, width: 1000, height: 700 });
    assert.equal(h.activeId(a), 'home');
    assert.equal(h.activeId(b), '__servers');
    assert.equal(b.title, 'Servers');
    assert.equal(h.activeId(c), 'work', 'a window saved on a removed profile opens the first one');
  });
  test('with no profiles yet, opens the Profiles screen on a new-profile form', async (t) => {
    const h = await loadMain(t, { profiles: [] });
    const w = h.win();
    assert.equal(h.activeId(w), '__profiles');
    const panel = h.viewFor(w, 'profiles');
    assert.match(panel.webContents.file, /profiles\.html$/);
    assert.deepEqual(panel.webContents.sentOn('editor-new'), [[]]);
    assert.equal(w.title, 'Profiles');
    assert.equal(h.menuItem('File', 'New Window For').enabled, false);
  });
  const badConfigs = [
    ['a duplicate profile id', { profiles: [WORK, { ...WORK }] }, /bad or duplicate profile id "work"/],
    ['an id with capitals or spaces', { profiles: [{ ...WORK, id: 'My Work' }] }, /bad or duplicate profile id "My Work"/],
    ['a file that is not JSON', { rawProfilesJson: '{ nope' }, /Could not read profiles\.json/],
  ];
  for (const [what, opts, message] of badConfigs) {
    test(`shows an error and quits on ${what}`, async (t) => {
      const h = await loadMain(t, opts);
      assert.equal(fe.state.errorBoxes.length, 1);
      assert.match(fe.state.errorBoxes[0].message, message);
      assert.equal(fe.state.quits, 1);
      assert.equal(h.appWindows().length, 0);
    });
  }
  test('a second copy of the app quits at once', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES, singleInstance: false });
    assert.equal(fe.state.quits, 1);
    assert.equal(h.appWindows().length, 0);
  });
  test('launching it again brings the existing window forward, or opens one', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    const w = h.win();
    w.minimized = true;
    fe.electron.app.emit('second-instance');
    assert.equal(w.minimized, false);
    assert.equal(fe.state.focusedWindow, w);
    w.close();
    fe.electron.app.emit('second-instance');
    await settle();
    assert.equal(h.appWindows().length, 1);
  });
  test('clicking the Dock icon with no windows open opens one', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    fe.electron.app.emit('activate');
    assert.equal(h.appWindows().length, 1, 'nothing happens while a window is open');
    h.win().close();
    fe.electron.app.emit('activate');
    await settle();
    assert.equal(h.appWindows().length, 1);
  });
  test('presents as Chrome, never as Electron, to every page', async (t) => {
    await loadMain(t, { profiles: PROFILES });
    const ua = fe.electron.app.userAgentFallback;
    assert.match(ua, /^Mozilla\/5\.0 \(Macintosh; Intel Mac OS X 10_15_7\) AppleWebKit\/537\.36 \(KHTML, like Gecko\) Chrome\/\S+ Safari\/537\.36$/);
    assert.doesNotMatch(ua, /Electron/);
    assert.equal(fe.state.sessions.get('persist:profile-work').userAgent, ua);
  });
});

describe('switching profiles', () => {
  test('loads a profile only when first shown, and shows one view at a time', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    const w = h.win();
    assert.equal(h.viewFor(w, 'home'), undefined);
    await h.select(w, 'home');
    const home = h.viewFor(w, 'home');
    assert.deepEqual(home.webContents.loads, ['https://claude.ai/code/pinned']);
    assert.equal(home.visible, true);
    assert.equal(h.viewFor(w, 'work').visible, false);
    assert.equal(h.activeId(w), 'home');
    assert.ok(home.webContents.focused > 0);
    await h.select(w, 'work');
    assert.deepEqual(h.viewFor(w, 'work').webContents.loads, ['https://claude.ai/code'], 'switching back does not reload');
  });
  test('profile pages are sandboxed, isolated and have no preload', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    const prefs = h.viewFor(h.win(), 'work').webPreferences;
    assert.equal(prefs.sandbox, true);
    assert.equal(prefs.contextIsolation, true);
    assert.equal(prefs.nodeIntegration, false);
    assert.equal(prefs.preload, undefined);
  });
  test('a Design profile that shares a sign-in uses that profile’s session', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    const w = h.win();
    await h.select(w, 'work-design');
    const views = h.contentViews(w).filter((v) => h.partitionOf(v) === 'persist:profile-work');
    assert.equal(views.length, 2, 'two views, one session');
    assert.deepEqual(views[1].webContents.loads, ['https://claude.ai/design']);
  });
  test('a sign-in shared with a profile that no longer exists falls back to the profile’s own', async (t) => {
    const h = await loadMain(t, { profiles: [{ ...DESIGN, shareSignIn: 'gone' }] });
    assert.ok(h.viewFor(h.win(), 'work-design'));
  });
  test('selecting "new" opens a blank profile form; an unknown id is ignored', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    const w = h.win();
    await h.select(w, 'nonexistent');
    assert.equal(h.activeId(w), 'work');
    await h.select(w, 'new');
    assert.equal(h.activeId(w), '__profiles');
    assert.equal(h.viewFor(w, 'profiles').webContents.sentOn('editor-new').length, 1);
  });
  test('a form request waits for a Profiles screen that is still loading', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    const w = h.win();
    await h.select(w, '__profiles');
    const panel = h.viewFor(w, 'profiles');
    panel.webContents.loading = true;
    await h.select(w, 'new');
    assert.equal(panel.webContents.sentOn('editor-new').length, 0);
    panel.webContents.emit('did-finish-load');
    assert.equal(panel.webContents.sentOn('editor-new').length, 1);
  });
  test('the title follows the page title of the active profile only', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    const w = h.win();
    await h.select(w, 'home');
    const work = h.viewFor(w, 'work').webContents;
    work.title = 'Some session';
    work.emit('page-title-updated');
    assert.equal(w.title, 'Home · Claude');
    await h.select(w, 'work');
    assert.equal(w.title, 'Work · Some session');
  });
  test('the sidebar is 76px wide and pages fill the rest, also after a resize', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    const w = h.win();
    w.resize(1200, 828);
    assert.deepEqual(h.sidebarOf(w).bounds, { x: 0, y: 0, width: 76, height: 800 });
    assert.deepEqual(h.viewFor(w, 'work').bounds, { x: 76, y: 0, width: 1124, height: 800 });
    w.resize(50, 228);
    assert.equal(h.viewFor(w, 'work').bounds.width, 0, 'never negative');
  });
  test('the sidebar’s profile list carries icons that exist', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    fe.state.images.set(path.join(h.configDir, 'icons', 'work.png'), 'full');
    const list = await fe.state.handlers.get('profiles')();
    assert.deepEqual(list.map((p) => [p.id, p.name, p.account, !!p.icon]), [['work', 'Work', 'alice@example.com', true], ['home', 'Home', 'alice@home.example', false], ['work-design', 'Work Design', 'alice@example.com', false]]);
    assert.match(list[0].icon, /^data:image\/png;base64,/);
  });
});

describe('profile sessions', () => {
  test('allow only the permissions Claude needs', async (t) => {
    await loadMain(t, { profiles: PROFILES });
    const ses = fe.state.sessions.get('persist:profile-work');
    for (const p of ['notifications', 'clipboard-read', 'clipboard-sanitized-write', 'fullscreen', 'media']) {
      assert.equal(ses.permissionCheckHandler(null, p), true, p);
      let granted;
      ses.permissionRequestHandler(null, p, (v) => { granted = v; });
      assert.equal(granted, true, p);
    }
    for (const p of ['geolocation', 'midi', 'openExternal', 'pointerLock', 'hid', 'serial', 'usb', 'display-capture']) {
      assert.equal(ses.permissionCheckHandler(null, p), false, p);
      let granted;
      ses.permissionRequestHandler(null, p, (v) => { granted = v; });
      assert.equal(granted, false, p);
    }
  });
  test('each sign-in gets its own partition, set up once', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    const w = h.win();
    await h.select(w, 'home');
    await h.select(w, 'work-design');
    assert.deepEqual([...fe.state.sessions.keys()].filter((k) => k.startsWith('persist:profile-')).sort(), ['persist:profile-home', 'persist:profile-work']);
  });
});

describe('links and navigation inside a profile', () => {
  async function workPage(t) {
    const h = await loadMain(t, { profiles: PROFILES });
    const wc = h.viewFor(h.win(), 'work').webContents;
    return { h, wc };
  }
  test('Claude and sign-in pages open in an isolated in-app window', async (t) => {
    const { wc } = await workPage(t);
    for (const url of ['https://claude.ai/chat/1', 'https://support.claude.com/x', 'https://docs.anthropic.com/y', 'https://abc.claude.site/artifact', 'https://x.claudeusercontent.com/p', 'https://accounts.google.com/o/oauth2', 'https://appleid.apple.com/auth', 'https://login.microsoftonline.com/common']) {
      const r = wc.open(url);
      assert.equal(r.action, 'allow', url);
      assert.equal(r.overrideBrowserWindowOptions.webPreferences.sandbox, true);
      assert.equal(r.overrideBrowserWindowOptions.webPreferences.contextIsolation, true);
    }
    assert.deepEqual(fe.state.externals, []);
  });
  test('everything else opens in the default browser', async (t) => {
    const { wc } = await workPage(t);
    for (const url of ['https://github.com/x', 'https://claude.ai.evil.example/login', 'https://notclaude.ai/', 'http://example.com', 'mailto:someone@example.com']) {
      assert.deepEqual(wc.open(url), { action: 'deny' }, url);
    }
    assert.deepEqual(fe.state.externals, ['https://github.com/x', 'https://claude.ai.evil.example/login', 'https://notclaude.ai/', 'http://example.com', 'mailto:someone@example.com']);
  });
  test('never hands a local file, app or script link to the operating system', async (t) => {
    const { wc } = await workPage(t);
    for (const url of ['file:///Applications/Calculator.app', 'javascript:alert(1)', 'vnc://host', 'smb://host/share', 'x-apple.systempreferences:com.apple.preference.security']) {
      assert.deepEqual(wc.open(url), { action: 'deny' }, url);
    }
    assert.deepEqual(fe.state.externals, []);
  });
  test('while signing in, every hop stays in the app (so an organisation’s own SSO works)', async (t) => {
    const { wc } = await workPage(t);
    for (const at of ['https://claude.ai/login?x=1', 'https://claude.ai/magic-link#abc', 'https://claude.ai/sso/start', 'https://sso.acme.example/saml', 'about:blank', '']) {
      wc.url = at;
      assert.equal(wc.open('https://sso.acme.example/next').action, 'allow', at);
      assert.equal(wc.willNavigate('https://idp.acme.example/next'), false, at);
    }
    wc.url = 'https://claude.ai/code';
    assert.equal(wc.open('https://sso.acme.example/next').action, 'deny');
  });
  test('navigating the page itself away from Claude opens the link outside instead', async (t) => {
    const { wc } = await workPage(t);
    assert.equal(wc.willNavigate('https://github.com/x'), true);
    assert.deepEqual(fe.state.externals, ['https://github.com/x']);
    assert.equal(wc.willNavigate('https://claude.ai/code/other'), false);
    assert.equal(wc.willNavigate('https://accounts.google.com/x'), false);
  });
  test('windows a profile opens are guarded the same way', async (t) => {
    const { wc } = await workPage(t);
    const child = new fe.FakeWebContents();
    child.url = 'https://claude.ai/chat';
    wc.emit('did-create-window', { webContents: child });
    assert.deepEqual(child.open('https://github.com/y'), { action: 'deny' });
    assert.deepEqual(fe.state.externals, ['https://github.com/y']);
    const grandchild = new fe.FakeWebContents();
    child.emit('did-create-window', { webContents: grandchild });
    assert.equal(typeof grandchild.windowOpenHandler, 'function');
  });
  test('Google’s embedded-browser refusal sends the page back to Claude’s sign-in and explains the email route', async (t) => {
    const { wc } = await workPage(t);
    wc.navigate('https://accounts.google.com/v3/signin/rejected?x=1');
    assert.equal(wc.loads.at(-1), 'https://claude.ai/login');
    assert.equal(fe.state.dialogs.length, 1);
    assert.match(fe.state.dialogs[0].message, /Sign in by email instead/);
    assert.match(fe.state.dialogs[0].detail, /Continue with email/);
    wc.navigate('https://accounts.google.com/v3/signin/identifier');
    assert.equal(fe.state.dialogs.length, 1, 'other Google pages are left alone');
  });
  test('a sign-in pop-up that Google refuses is closed', async (t) => {
    const { wc } = await workPage(t);
    const popup = new fe.FakeWebContents();
    wc.emit('did-create-window', { webContents: popup });
    popup.navigate('https://accounts.google.com/signin/rejected');
    assert.equal(popup.destroyed, true);
    assert.equal(fe.state.dialogs.length, 1);
  });
});

describe('a page that does not load', () => {
  async function workPage(t) {
    const h = await loadMain(t, { profiles: PROFILES });
    return h.viewFor(h.win(), 'work').webContents;
  }
  const failurePage = (wc) => {
    const last = wc.loads.at(-1);
    return last.startsWith('data:text/html') ? decodeURIComponent(last.slice(last.indexOf(',') + 1)) : null;
  };
  const fail = (wc, code, description, url = 'https://claude.ai/code', isMainFrame = true) => wc.emit('did-fail-load', {}, code, description, url, isMainFrame);
  test('says why, logs it, and tries again later each time it fails', async (t) => {
    const wc = await workPage(t);
    fail(wc, -21, 'ERR_NETWORK_CHANGED');
    let page = failurePage(wc);
    assert.match(page, /ERR_NETWORK_CHANGED \(-21\)/);
    assert.match(page, /const target = "https:\/\/claude\.ai\/code";/);
    assert.match(page, /let left = 2;/);
    assert.ok(callsOf('log').some(([m]) => m === 'Work: https://claude.ai/code did not load (ERR_NETWORK_CHANGED (-21)), trying again in 2s'));
    // Electron's own order: its blank error page "finishes loading" at the failed address after each failure.
    fail(wc, -106, 'ERR_INTERNET_DISCONNECTED');
    assert.match(failurePage(wc), /let left = 5;/, 'each failure waits longer');
    wc.url = 'https://claude.ai/code';
    wc.emit('did-finish-load');
    fail(wc, -106, 'ERR_INTERNET_DISCONNECTED');
    assert.match(failurePage(wc), /let left = 15;/, 'the error page finishing does not start the wait over');
    wc.navigate('https://claude.ai/code');
    fail(wc, -21, 'ERR_NETWORK_CHANGED');
    assert.match(failurePage(wc), /let left = 2;/, 'a page that loads starts the wait over');
  });
  test('keeps the address it retries from breaking out of the page', async (t) => {
    const wc = await workPage(t);
    fail(wc, -2, 'ERR_FAILED', 'https://claude.ai/x?q=</script><img src=x>');
    const page = failurePage(wc);
    assert.ok(!page.includes('<img'), page);
    assert.match(page, /const target = "https:\/\/claude\.ai\/x\?q=\\u003c\/script>\\u003cimg src=x>";/);
  });
  test('ignores frames inside the page, non-web pages, and a navigation another one replaced', async (t) => {
    const wc = await workPage(t);
    const before = wc.loads.length;
    fail(wc, -2, 'ERR_FAILED', 'https://x.claudeusercontent.com/frame', false);
    fail(wc, -2, 'ERR_FAILED', 'about:blank');
    wc.navigate('https://claude.ai/code');
    fail(wc, -3, 'ERR_ABORTED', 'https://claude.ai/code/next');
    t.mock.timers.tick(1000);
    assert.equal(wc.loads.length, before);
  });
  test('a first load abandoned with nothing shown is not left blank', async (t) => {
    const wc = await workPage(t);
    wc.loading = true;
    fail(wc, -3, 'ERR_ABORTED');
    t.mock.timers.tick(1000);
    assert.equal(failurePage(wc), null, 'another load is under way');
    wc.loading = false;
    fail(wc, -3, 'ERR_ABORTED');
    t.mock.timers.tick(1000);
    assert.match(failurePage(wc), /ERR_ABORTED \(-3\)/);
  });
  test('a page whose renderer stops is reloaded, but not after a clean exit', async (t) => {
    const wc = await workPage(t);
    wc.url = 'https://claude.ai/design';
    wc.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
    assert.equal(failurePage(wc), null);
    wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 11 });
    assert.match(failurePage(wc), /the page stopped: crashed/);
    assert.match(failurePage(wc), /const target = "https:\/\/claude\.ai\/design";/);
  });
});

describe('the right-click menu', () => {
  async function menuFor(t, params) {
    const h = await loadMain(t, { profiles: PROFILES });
    const wc = h.viewFor(h.win(), 'work').webContents;
    wc.emit('context-menu', {}, { x: 5, y: 6, dictionarySuggestions: [], ...params });
    const menu = fe.state.menus.at(-1);
    assert.equal(menu.popups, 1);
    return { wc, items: menu.template, labels: menu.template.map((i) => i.label || i.role || i.type) };
  }
  test('on a Claude link: open in browser, open here, copy', async (t) => {
    const { wc, items, labels } = await menuFor(t, { linkURL: 'https://claude.ai/code/x' });
    assert.deepEqual(labels, ['Open Link in Browser', 'Open Link Here', 'Copy Link', 'separator', 'separator', 'Inspect Element']);
    items[0].click();
    items[1].click();
    items[2].click();
    assert.deepEqual(fe.state.externals, ['https://claude.ai/code/x']);
    assert.equal(wc.loads.at(-1), 'https://claude.ai/code/x');
    assert.equal(fe.state.clipboard, 'https://claude.ai/code/x');
    items.at(-1).click();
    assert.deepEqual(wc.inspectedAt, [5, 6]);
  });
  test('an outside link cannot be opened inside the profile', async (t) => {
    const { labels } = await menuFor(t, { linkURL: 'https://github.com/x' });
    assert.ok(!labels.includes('Open Link Here'));
  });
  test('in a text field: spelling suggestions, then cut, copy, paste, select all', async (t) => {
    const { wc, items, labels } = await menuFor(t, { isEditable: true, dictionarySuggestions: ['their', 'there'] });
    assert.deepEqual(labels, ['their', 'there', 'separator', 'cut', 'copy', 'paste', 'selectAll', 'separator', 'Inspect Element']);
    items[1].click();
    assert.equal(wc.replaced, 'there');
  });
  test('on selected text: copy; on an image: copy image', async (t) => {
    const a = await menuFor(t, { selectionText: 'hello' });
    assert.deepEqual(a.labels, ['copy', 'separator', 'Inspect Element']);
    const b = await menuFor(t, { mediaType: 'image', x: 9, y: 8 });
    assert.deepEqual(b.labels, ['Copy Image', 'separator', 'Inspect Element']);
    b.items[0].click();
    assert.deepEqual(b.wc.copiedImageAt, [9, 8]);
  });
});

describe('the app menu', () => {
  test('lists profiles with ⌘1–⌘9 and New Window For with ⇧⌘1–⇧⌘9', async (t) => {
    const many = Array.from({ length: 11 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, account: `p${i}@example.com` }));
    const h = await loadMain(t, { profiles: many });
    const items = h.menuItem('Profiles').submenu.filter((i) => i.label?.startsWith('P'));
    assert.equal(items[0].label, 'P0 (p0@example.com)');
    assert.equal(items[0].accelerator, 'CmdOrCtrl+1');
    assert.equal(items[8].accelerator, 'CmdOrCtrl+9');
    assert.equal(items[9].accelerator, undefined);
    const forItems = h.menuItem('File', 'New Window For').submenu;
    assert.equal(forItems[8].accelerator, 'CmdOrCtrl+Shift+9');
    assert.equal(forItems[10].accelerator, undefined);
  });
  test('profile items switch the focused window', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    h.menuItem('Profiles', 'Home (alice@home.example)').click();
    await settle();
    assert.equal(h.activeId(h.win()), 'home');
  });
  test('Next and Previous Profile wrap around, and step from an app screen to the first profile', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    const w = h.win();
    const next = h.menuItem('Profiles', 'Next Profile');
    const prev = h.menuItem('Profiles', 'Previous Profile');
    assert.equal(next.accelerator, 'Ctrl+Tab');
    prev.click();
    assert.equal(h.activeId(w), 'work-design');
    next.click();
    assert.equal(h.activeId(w), 'work');
    next.click();
    assert.equal(h.activeId(w), 'home');
    await h.select(w, '__servers');
    next.click();
    assert.equal(h.activeId(w), 'work');
  });
  test('Manage Profiles, Servers and Add Profile open the app screens', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    const w = h.win();
    h.menuItem('Profiles', 'Servers').click();
    assert.equal(h.activeId(w), '__servers');
    assert.match(h.viewFor(w, 'servers').webContents.file, /servers\.html$/);
    h.menuItem('Profiles', 'Manage Profiles').click();
    assert.equal(h.activeId(w), '__profiles');
    h.menuItem('Profiles', 'Add Profile…').click();
    await settle();
    assert.equal(h.viewFor(w, 'profiles').webContents.sentOn('editor-new').length, 1);
    h.menuItem('Profiles', 'Show Data Folder').click();
    assert.deepEqual(fe.state.openedPaths, [h.configDir]);
  });
  test('New Window opens a window on the same screen, offset from the focused one', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    const w = h.win();
    await h.select(w, 'home');
    w.focus();
    h.menuItem('File', 'New Window').click();
    await settle();
    const second = h.win(1);
    assert.equal(h.activeId(second), 'home');
    assert.equal(second.bounds.x, w.bounds.x + 30);
    h.menuItem('File', 'New Window For', 'Work Design').click();
    await settle();
    assert.equal(h.activeId(h.win(2)), 'work-design');
  });
  test('View menu actions apply to the active page', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    const w = h.win();
    w.focus();
    const wc = h.viewFor(w, 'work').webContents;
    h.menuItem('View', 'Reload').click();
    assert.equal(wc.reloads, 1);
    h.menuItem('View', 'Back').click();
    h.menuItem('View', 'Forward').click();
    assert.deepEqual(wc.loads.slice(-2), ['<back>', '<forward>']);
    wc.url = 'https://claude.ai/code/session_x';
    h.menuItem('View', 'Copy Page Link').click();
    assert.equal(fe.state.clipboard, 'https://claude.ai/code/session_x');
    h.menuItem('View', 'Open Page in Browser').click();
    assert.deepEqual(fe.state.externals, ['https://claude.ai/code/session_x']);
    h.menuItem('View', 'Profile Home').click();
    assert.equal(wc.loads.at(-1), 'https://claude.ai/code');
    h.menuItem('View', 'Developer Tools').click();
    assert.equal(wc.devTools, true);
  });
  test('Open Copied Link opens only a web link, and only in a profile', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    const w = h.win();
    w.focus();
    const wc = h.viewFor(w, 'work').webContents;
    const item = h.menuItem('View', 'Open Copied Link in This Profile');
    fe.state.clipboard = '  https://claude.ai/magic-link#token  ';
    item.click();
    assert.equal(wc.loads.at(-1), 'https://claude.ai/magic-link#token');
    fe.state.clipboard = 'file:///etc/passwd';
    item.click();
    assert.equal(wc.loads.at(-1), 'https://claude.ai/magic-link#token');
    await h.select(w, '__servers');
    fe.state.clipboard = 'https://claude.ai/x';
    item.click();
    assert.ok(!h.viewFor(w, 'servers').webContents.loads.includes('https://claude.ai/x'));
  });
});

describe('the Dock icon', () => {
  const withIcon = (kind) => async (t, extra = {}) => {
    const h = await loadMain(t, { profiles: [WORK, HOME], extra });
    fe.state.images.set(path.join(h.configDir, 'icons', 'work.png'), kind);
    return h;
  };
  test('takes on the active profile’s icon when its window is focused, padded to the macOS icon grid', { skip: process.platform !== 'darwin' && 'macOS only' }, async (t) => {
    const h = await withIcon('full')(t);
    const w = h.win();
    w.focus();
    assert.equal(fe.state.dockIcons.length, 1);
    const img = fe.state.dockIcons[0];
    assert.equal(img.width, 512);
    const bmp = img.toBitmap();
    const alpha = (x, y) => bmp[(y * 512 + x) * 4 + 3];
    // 824 of 1024 is the visible tile: (512 - 412) / 2 = 50 px of margin on each side.
    assert.equal(alpha(49, 256), 0);
    assert.equal(alpha(50, 256), 255);
    assert.equal(alpha(461, 256), 255);
    assert.equal(alpha(462, 256), 0);
    assert.equal(alpha(256, 0), 0);
  });
  test('an icon that already has transparent margins is used as it is', { skip: process.platform !== 'darwin' && 'macOS only' }, async (t) => {
    const h = await withIcon('margins')(t);
    h.win().focus();
    assert.equal(fe.state.dockIcons[0].kind, 'margins');
    assert.equal(fe.state.dockIcons[0].width, 1024);
  });
  test('the padded image is made once per icon', { skip: process.platform !== 'darwin' && 'macOS only' }, async (t) => {
    const h = await withIcon('full')(t);
    const w = h.win();
    w.focus();
    await h.select(w, 'home');
    await h.select(w, 'work');
    assert.equal(fe.state.dockIcons.length, 2);
    assert.equal(fe.state.dockIcons[0], fe.state.dockIcons[1]);
  });
  test('is left alone for a profile without an icon, an unreadable icon, or when turned off', async (t) => {
    const h = await withIcon(null)(t);
    const w = h.win();
    w.focus();
    await h.select(w, 'home');
    assert.equal(fe.state.dockIcons.length, 0);
    const h2 = await withIcon('full')(t, { dockIconFollowsProfile: false });
    h2.win().focus();
    assert.equal(fe.state.dockIcons.length, 0);
  });
});

describe('closing windows and saving the layout', () => {
  test('a closed window releases its pages and is dropped from the saved layout', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES, saved: { windows: [{ activeId: 'work' }, { activeId: 'home' }] } });
    const [a, b] = h.appWindows();
    const pages = [h.sidebarOf(a), ...h.contentViews(a)].map((v) => v.webContents);
    a.close();
    assert.ok(pages.every((wc) => wc.destroyed));
    assert.equal(a.contentView.children.length, 0);
    const saved = sb.readJson(path.join(h.userData, 'state.json'));
    assert.deepEqual(saved.windows.map((x) => x.activeId), ['home']);
    assert.equal(h.appWindows().length, 1);
    assert.equal(h.appWindows()[0], b);
  });
  test('late events from a closed window are ignored', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    const w = h.win();
    w.close();
    assert.doesNotThrow(() => { w.emit('resize'); w.emit('moved'); w.emit('focus'); });
  });
  test('closing the last window keeps the layout for the next launch', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES, saved: { windows: [{ activeId: 'home' }] } });
    await h.select(h.win(), 'work-design');
    const before = fs.readFileSync(path.join(h.userData, 'state.json'), 'utf8');
    h.win().close();
    assert.equal(fs.readFileSync(path.join(h.userData, 'state.json'), 'utf8'), before);
    assert.deepEqual(JSON.parse(before).windows.map((x) => x.activeId), ['work-design']);
  });
  test('quitting saves every open window; teardown during quit leaves the layout alone', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES, saved: { windows: [{ activeId: 'work' }, { activeId: 'home' }] } });
    fe.electron.app.emit('before-quit');
    for (const w of h.appWindows()) w.close();
    const saved = sb.readJson(path.join(h.userData, 'state.json'));
    assert.deepEqual(saved.windows.map((x) => x.activeId), ['work', 'home']);
  });
  test('moving or switching saves the layout', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    const w = h.win();
    w.bounds = { x: 111, y: 222, width: 1300, height: 800 };
    w.emit('moved');
    assert.deepEqual(sb.readJson(path.join(h.userData, 'state.json')).windows[0].bounds, w.bounds);
  });
  test('a status push never reaches a closed window', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES, saved: { windows: [{ activeId: 'work' }, { activeId: 'home' }] } });
    h.win(0).close();
    t.mock.timers.tick(30000);
    await settle();
    assert.ok(h.sidebarOf(h.win(0)).webContents.sentOn('status').length >= 1);
  });
});

describe('server status in the sidebar', () => {
  test('summarises each profile’s servers every 30 seconds', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    mgr.impl.status = async () => ({ servers: [
      { profileId: 'work', pid: 10, problem: null, sessions: [{}, {}], terminal: [] },
      { profileId: 'work', pid: null, problem: 'folder not trusted', sessions: [], terminal: [{ sessions: [{}] }] },
      { profileId: 'home', pid: null, problem: null, sessions: [], terminal: [{ sessions: [{}, {}, {}] }] },
      { profileId: 'other', pid: null, problem: null, sessions: [], terminal: [] },
    ], unmanaged: [] });
    t.mock.timers.tick(30000);
    await settle();
    assert.deepEqual(h.sidebarOf(h.win()).webContents.sentOn('status').at(-1)[0], {
      work: { state: 'running', sessions: 3, problem: true },
      home: { state: 'terminal', sessions: 3, problem: false },
      other: { state: 'stopped', sessions: 0, problem: false },
    });
  });
  test('a failing status check sends nothing and does not throw', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    mgr.impl.status = async () => { throw new Error('ps failed'); };
    const before = h.sidebarOf(h.win()).webContents.sentOn('status').length;
    t.mock.timers.tick(30000);
    await settle();
    assert.equal(h.sidebarOf(h.win()).webContents.sentOn('status').length, before);
  });
  test('a new window gets the last status as soon as its sidebar loads', async (t) => {
    const h = await loadMain(t, { profiles: PROFILES });
    mgr.impl.status = async () => ({ servers: [{ profileId: 'work', pid: 1, problem: null, sessions: [], terminal: [] }], unmanaged: [] });
    t.mock.timers.tick(30000);
    await settle();
    h.menuItem('File', 'New Window').click();
    await settle();
    assert.deepEqual(h.sidebarOf(h.win(1)).webContents.sentOn('status')[0][0], { work: { state: 'running', sessions: 0, problem: false } });
  });
});

describe('opening a stranded Remote Control session', () => {
  async function setup(t, { record, continued = { sessionId: 'cse_NEW1' }, events = [] } = {}) {
    const h = await loadMain(t, { profiles: PROFILES });
    fe.route('GET', '/v1/code/sessions?statuses=active', { data: record === null ? [] : [record || { id: 'cse_OLD1', environment_kind: 'bridge' }] });
    fe.route('GET', '/events?limit=50&sort_order=desc', { data: events });
    mgr.impl.continueSession = async () => continued;
    const wc = h.viewFor(h.win(), 'work').webContents;
    return { h, wc };
  }
  test('carries it on and moves the view to the continuation', async (t) => {
    const { wc } = await setup(t);
    wc.navigate('https://claude.ai/code/session_OLD1');
    await settle();
    const [[ids, record]] = callsOf('continueSession');
    assert.deepEqual(ids, ['work', 'work']);
    assert.equal(record.id, 'cse_OLD1');
    assert.equal(wc.loads.at(-1), 'https://claude.ai/code/session_NEW1');
    const f = fe.state.fetches.find((x) => x.url.includes('/v1/code/sessions?'));
    assert.equal(f.partition, 'persist:profile-work');
    assert.equal(f.headers['anthropic-client-platform'], 'web_claude_ai');
  });
  test('a Design profile on a shared sign-in looks under both profiles', async (t) => {
    const { h } = await setup(t);
    const w = h.win();
    await h.select(w, 'work-design');
    const design = h.contentViews(w).filter((v) => h.partitionOf(v) === 'persist:profile-work')[1].webContents;
    design.navigateInPage('https://claude.ai/code/cse_OLD1');
    await settle();
    assert.deepEqual(callsOf('continueSession')[0][0], ['work-design', 'work']);
  });
  test('passes a lookup of the session’s latest message ids', async (t) => {
    const { wc } = await setup(t, { events: [
      { event_type: 'user', payload: { uuid: 'u1' } }, { event_type: 'assistant', payload: { uuid: 'a1' } },
      { event_type: 'system', payload: { uuid: 's1' } }, { event_type: 'user', payload: {} },
    ] });
    wc.navigate('https://claude.ai/code/session_OLD1');
    await settle();
    const [[, , { messageIds }]] = callsOf('continueSession');
    assert.deepEqual(await messageIds(), ['u1', 'a1']);
    assert.ok(fe.state.fetches.some((f) => f.url.includes('/v1/code/sessions/session_OLD1/events')));
  });
  test('tries a session at most once every two minutes', async (t) => {
    const { wc } = await setup(t, { continued: { skipped: 'connected' } });
    wc.navigate('https://claude.ai/code/session_OLD1');
    await settle();
    wc.navigate('https://claude.ai/code/session_OLD1');
    await settle();
    assert.equal(callsOf('continueSession').length, 1);
  });
  test('does nothing for a page that is not a session, or a session claude.ai does not list', async (t) => {
    const { wc } = await setup(t, { record: null });
    wc.navigate('https://claude.ai/code');
    wc.navigate('https://claude.ai/code/settings');
    wc.navigate('https://evil.example/claude.ai/code/session_X');
    wc.navigate('https://claude.ai/code/session_UNLISTED');
    await settle();
    assert.equal(callsOf('continueSession').length, 0);
  });
  test('does not move a view that has already gone elsewhere', async (t) => {
    const { wc } = await setup(t);
    let release;
    mgr.impl.continueSession = () => new Promise((r) => { release = r; });
    wc.navigate('https://claude.ai/code/session_OLD1');
    await settle();
    wc.url = 'https://claude.ai/code/session_OTHER';
    release({ sessionId: 'cse_NEW1' });
    await settle();
    assert.ok(!wc.loads.includes('https://claude.ai/code/session_NEW1'));
  });
  test('a failure is logged, not thrown', async (t) => {
    const { wc } = await setup(t);
    mgr.impl.continueSession = async () => { throw new Error('disk full'); };
    t.mock.method(console, 'log', () => {});
    wc.navigate('https://claude.ai/code/session_OLD1');
    await settle();
    assert.equal(console.log.mock.calls.at(-1).arguments[0], '[continue] failed');
  });
});
