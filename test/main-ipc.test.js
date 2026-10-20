'use strict';
const { sb, fe, fakeCp, mgr, callsOf, loadMain, settle } = require('./helpers/main-fixture');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORK = { id: 'work', name: 'Work', account: 'alice@example.com', configDir: '~/.claude-work', servers: [] };
const HOME = { id: 'home', name: 'Home', account: 'alice@home.example', configDir: '~/.claude-home' };
const DESIGN = { id: 'work-design', kind: 'design', name: 'Work Design', account: 'alice@example.com', shareSignIn: 'work' };

describe('who may call the manager and the profile editor', () => {
  test('only the Servers screen reaches the manager', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    const w = h.win();
    await assert.rejects(h.invoke('mgr', h.sidebarOf(w).webContents, 'status'), /not allowed/);
    await assert.rejects(h.invoke('mgr', h.viewFor(w, 'work').webContents, 'stop', 'work-app'), /not allowed/);
    await h.select(w, '__profiles');
    await assert.rejects(h.invoke('mgr', h.viewFor(w, 'profiles').webContents, 'status'), /not allowed/);
    await assert.rejects(h.invoke('mgr', new fe.FakeWebContents(), 'status'), /not allowed/);
    assert.equal(callsOf('stopServer').length, 0);
  });
  test('only the Profiles screen reaches the editor', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    const w = h.win();
    await assert.rejects(h.invoke('editor', h.viewFor(w, 'work').webContents, 'remove', 'work'), /not allowed/);
    await h.select(w, '__servers');
    await assert.rejects(h.invoke('editor', h.viewFor(w, 'servers').webContents, 'list'), /not allowed/);
    assert.equal(P().profiles.length, 1);
    function P() { return sb.readJson(h.file('profiles.json')); }
  });
  test('unknown actions are refused', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    await assert.rejects(h.mgrCall(h.win(), 'rmrf'), /unknown action rmrf/);
    await assert.rejects(h.editorCall(h.win(), 'nope'), /unknown action nope/);
  });
  test('names inherited from Object.prototype are refused too', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    for (const action of ['constructor', 'toString', 'valueOf', 'hasOwnProperty']) {
      await assert.rejects(h.mgrCall(h.win(), action), new RegExp(`unknown action ${action}`));
      await assert.rejects(h.editorCall(h.win(), action), new RegExp(`unknown action ${action}`));
    }
  });
});

describe('Servers screen actions', () => {
  test('pass through to the manager, coercing ids from the page', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    const w = h.win();
    await h.mgrCall(w, 'start', 'work-app');
    await h.mgrCall(w, 'stop', 'work-app');
    await h.mgrCall(w, 'endSession', '4242');
    await h.mgrCall(w, 'stopUnmanaged', '777');
    await h.mgrCall(w, 'keep', 'cse_x', true);
    await h.mgrCall(w, 'setCleanup', true);
    await h.mgrCall(w, 'reap', 1);
    await h.mgrCall(w, 'reap');
    await h.mgrCall(w, 'mcpList', 'work-app');
    await h.mgrCall(w, 'mcpAdd', 'work-app');
    await h.mgrCall(w, 'mcpRemove', 'work-app', 'api', 'user');
    assert.deepEqual(callsOf('startServer'), [['work-app']]);
    assert.deepEqual(callsOf('stopServer'), [['work-app']]);
    assert.deepEqual(callsOf('endSession'), [[4242]]);
    assert.deepEqual(callsOf('stopUnmanagedServer'), [[777]]);
    assert.deepEqual(callsOf('setKeep'), [['cse_x', true]]);
    assert.deepEqual(callsOf('setCleanup'), [[true]]);
    assert.deepEqual(callsOf('reap'), [[{ dryRun: true }], [{ dryRun: false }]]);
    assert.deepEqual(callsOf('mcpList'), [['work-app']]);
    assert.deepEqual(callsOf('mcpAdd'), [['work-app', {}]]);
    assert.deepEqual(callsOf('mcpRemove'), [['work-app', 'api', 'user']]);
  });
  test('restart waits for the old server to stop before starting the new one', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    const order = [];
    let release;
    mgr.impl.stopServer = () => new Promise((r) => { order.push('stop'); release = () => { order.push('stopped'); r(); }; });
    mgr.impl.startServer = async () => { order.push('start'); };
    const p = h.mgrCall(h.win(), 'restart', 'work-app');
    await settle();
    assert.deepEqual(order, ['stop']);
    release();
    await p;
    assert.deepEqual(order, ['stop', 'stopped', 'start']);
  });
  test('an action refreshes the sidebar badges shortly after', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    await h.mgrCall(h.win(), 'stop', 'work-app');
    const before = callsOf('status').length;
    t.mock.timers.tick(1499);
    assert.equal(callsOf('status').length, before);
    t.mock.timers.tick(1);
    assert.equal(callsOf('status').length, before + 1);
  });
  test('errors from the manager reach the page', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    mgr.impl.startServer = async () => { throw new Error('folder not trusted'); };
    await assert.rejects(h.mgrCall(h.win(), 'start', 'work-app'), /folder not trusted/);
  });
  test('packaged and openConfig', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    const w = h.win();
    assert.equal(await h.mgrCall(w, 'packaged'), false);
    await h.mgrCall(w, 'openConfig');
    assert.equal(h.activeId(w), '__profiles');
  });
  test('mcpTerminal opens claude in Terminal under the profile, quoting paths for the shell', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    mgr.impl.mcpTarget = () => ({ folder: "/code/it's here", configDir: '/cfg/a b', profileId: 'work' });
    fakeCp.on('osascript', '');
    const r = await h.mgrCall(h.win(), 'mcpTerminal', 'work-app');
    const command = `cd '/code/it'\\''s here' && CLAUDE_CONFIG_DIR='/cfg/a b' claude`;
    assert.deepEqual(r, { ran: true, command });
    const [call] = fakeCp.callsTo('osascript');
    // AppleScript string literals escape backslashes and quotes the way JSON does.
    assert.deepEqual(call.args, ['-e', 'tell application "Terminal" to activate', '-e', `tell application "Terminal" to do script ${JSON.stringify(command)}`]);
  });
});

describe('server status with session titles', () => {
  const status = () => ({
    servers: [{ key: 'work-app', profileId: 'work', pid: 1, problem: null, sessions: [{ sessionId: 'cse_a' }, { sessionId: 'cse_zz' }], terminal: [{ sessions: [{ sessionId: 'cse_b' }] }] }],
    unmanaged: [{ pid: 9, sessions: [{ sessionId: 'cse_c' }] }],
  });
  test('adds the titles claude.ai shows, fetched with each profile’s own sign-in', async (t) => {
    const h = await loadMain(t, { profiles: [WORK, HOME, DESIGN] });
    mgr.impl.status = async () => status();
    fe.route('GET', '/v1/code/sessions?statuses=active', (url, opts, ses) => ({
      data: ses.partition === 'persist:profile-work'
        ? [{ id: 'cse_a', title: 'Fix the build', last_event_at: '2026-10-19T08:00:00Z' }, { id: 'cse_b', title: null }]
        : [{ id: 'cse_c', title: 'From home' }],
    }));
    const st = await h.mgrCall(h.win(), 'status');
    assert.deepEqual(st.servers[0].sessions, [{ sessionId: 'cse_a', title: 'Fix the build', lastEventAt: '2026-10-19T08:00:00Z' }, { sessionId: 'cse_zz' }]);
    assert.deepEqual(st.servers[0].terminal[0].sessions, [{ sessionId: 'cse_b', title: null, lastEventAt: null }]);
    assert.deepEqual(st.unmanaged[0].sessions, [{ sessionId: 'cse_c', title: 'From home', lastEventAt: null }]);
    const partitions = fe.state.fetches.filter((f) => f.url.includes('/v1/code/sessions?')).map((f) => f.partition).sort();
    assert.deepEqual(partitions, ['persist:profile-home', 'persist:profile-work'], 'a shared sign-in is not fetched twice');
  });
  test('prefers the server’s own profile when two accounts know a session', async (t) => {
    const h = await loadMain(t, { profiles: [HOME, WORK] });
    mgr.impl.status = async () => status();
    fe.route('GET', '/v1/code/sessions?statuses=active', (_u, _o, ses) => ({ data: [{ id: 'cse_a', title: ses.partition.endsWith('work') ? 'Work title' : 'Home title' }] }));
    const st = await h.mgrCall(h.win(), 'status');
    assert.equal(st.servers[0].sessions[0].title, 'Work title');
  });
  test('caches titles for a minute', async (t) => {
    const h = await loadMain(t, { profiles: [WORK], now: 1_000_000 });
    mgr.impl.status = async () => status();
    fe.route('GET', '/v1/code/sessions?statuses=active', { data: [] });
    const w = h.win();
    await h.mgrCall(w, 'status');
    await h.mgrCall(w, 'status');
    const count = () => fe.state.fetches.filter((f) => f.url.includes('/v1/code/sessions?')).length;
    assert.equal(count(), 1);
    t.mock.timers.tick(60001);
    await h.mgrCall(w, 'status');
    assert.equal(count(), 2);
  });
  test('falls back to ids when claude.ai cannot be reached', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    mgr.impl.status = async () => status();
    fe.route('GET', '/v1/code/sessions?statuses=active', () => new Error('offline'));
    const st = await h.mgrCall(h.win(), 'status');
    assert.deepEqual(st.servers[0].sessions, [{ sessionId: 'cse_a' }, { sessionId: 'cse_zz' }]);
  });
  test('the status call also refreshes the sidebar from the same snapshot', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    mgr.impl.status = async () => status();
    const before = callsOf('status').length;
    await h.mgrCall(h.win(), 'status');
    await settle();
    assert.equal(callsOf('status').length, before + 1, 'one manager status call serves both');
    assert.deepEqual(h.sidebarOf(h.win()).webContents.sentOn('status').at(-1)[0], { work: { state: 'running', sessions: 3, problem: false } });
  });
});

describe('MCP sign-in', () => {
  function fakeLogin({ url = 'https://auth.example/authorize?x=1', output = '' } = {}) {
    const login = { cancelled: 0, cancel() { this.cancelled++; } };
    mgr.impl.mcpTarget = () => ({ profileId: 'work', folder: '/code', configDir: '/cfg' });
    mgr.impl.mcpLogin = async (_key, _name, onUrl) => {
      if (url) onUrl(url);
      login.done = Promise.resolve({ url, output });
      return login;
    };
    return login;
  }
  test('an MCP server’s link opens in the default browser', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    fakeLogin();
    const r = await h.mgrCall(h.win(), 'mcpLogin', 'work-app', 'github');
    assert.deepEqual(r, { url: 'https://auth.example/authorize?x=1', opened: 'browser' });
    assert.deepEqual(fe.state.externals, ['https://auth.example/authorize?x=1']);
  });
  test('a claude.ai connector opens in a window on the profile’s own sign-in, and finishes when it closes', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    fakeLogin({ url: 'https://claude.ai/connect/gmail?x=1' });
    let result;
    const p = h.mgrCall(h.win(), 'mcpLogin', 'work-app', 'claude.ai Gmail').then((r) => { result = r; });
    await settle();
    const win = fe.state.windows.find((x) => x instanceof fe.electron.BrowserWindow);
    assert.equal(win.opts.title, 'Work · claude.ai Gmail');
    assert.equal(win.webContents.session.partition, 'persist:profile-work');
    assert.equal(win.webContents.prefs.sandbox, true);
    assert.deepEqual(win.webContents.loads, ['https://claude.ai/connect/gmail?x=1']);
    assert.deepEqual(fe.state.externals, []);
    assert.equal(result, undefined, 'still waiting for the window');
    assert.deepEqual(win.webContents.open('https://github.com/x'), { action: 'deny' });
    assert.deepEqual(fe.state.externals, ['https://github.com/x']);
    win.close();
    await p;
    assert.deepEqual(result, { url: 'https://claude.ai/connect/gmail?x=1', opened: 'app' });
  });
  test('a connector whose link is not on claude.ai opens in the browser', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    fakeLogin({ url: 'https://evil.example/claude.ai' });
    const r = await h.mgrCall(h.win(), 'mcpLogin', 'work-app', 'claude.ai Gmail');
    assert.equal(r.opened, 'browser');
  });
  test('Google refusing a connector in the app offers the browser or the link', async (t) => {
    for (const [response, check] of [[0, () => assert.deepEqual(fe.state.externals, ['https://claude.ai/connect/gmail'])], [1, () => assert.equal(fe.state.clipboard, 'https://claude.ai/connect/gmail')], [2, () => assert.deepEqual(fe.state.externals, [])]]) {
      const h = await loadMain(t, { profiles: [WORK] });
      fe.state.messageBoxResponse = response;
      fakeLogin({ url: 'https://claude.ai/connect/gmail' });
      const p = h.mgrCall(h.win(), 'mcpLogin', 'work-app', 'claude.ai Gmail');
      await settle();
      const win = fe.state.windows.find((x) => x instanceof fe.electron.BrowserWindow);
      win.webContents.navigate('https://accounts.google.com/signin/rejected');
      await settle();
      assert.match(fe.state.dialogs[0].message, /Google does not allow claude\.ai Gmail/);
      assert.match(fe.state.dialogs[0].detail, /signed in to claude\.ai as alice@example\.com/);
      assert.equal(win.destroyed, true);
      check();
      await p;
    }
  });
  test('reports the CLI’s output when it printed no link', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    fakeLogin({ url: null, output: 'Error: no server github' });
    assert.deepEqual(await h.mgrCall(h.win(), 'mcpLogin', 'work-app', 'github'), { error: 'Error: no server github' });
    fakeLogin({ url: null, output: '' });
    assert.deepEqual(await h.mgrCall(h.win(), 'mcpLogin', 'work-app', 'github'), { error: 'claude mcp login github printed no sign-in link' });
  });
  test('cancel stops a running sign-in; starting again replaces it', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    mgr.impl.mcpTarget = () => ({ profileId: 'work' });
    const logins = [];
    mgr.impl.mcpLogin = async () => {
      const l = { cancelled: 0, cancel() { this.cancelled++; }, done: new Promise(() => {}) };
      logins.push(l);
      return l;
    };
    const w = h.win();
    h.mgrCall(w, 'mcpLogin', 'work-app', 'github');
    await settle();
    h.mgrCall(w, 'mcpLogin', 'work-app', 'github');
    await settle();
    assert.equal(logins[0].cancelled, 1);
    await h.mgrCall(w, 'mcpCancel', 'work-app', 'github');
    assert.equal(logins[1].cancelled, 1);
    await h.mgrCall(w, 'mcpCancel', 'work-app', 'not-running');
  });
  test('a server whose profile is gone is refused', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    mgr.impl.mcpTarget = () => ({ profileId: 'deleted' });
    await assert.rejects(h.mgrCall(h.win(), 'mcpLogin', 'deleted-x', 'github'), /no profile for deleted-x/);
  });
});

describe('Profiles screen', () => {
  test('list describes each profile’s setup without reading secrets', async (t) => {
    const folder = sb.dir('folder');
    const h = await loadMain(t, { profiles: [{ ...WORK, servers: [{ id: 'app', folder }] }, DESIGN] });
    fe.state.cookies.set('persist:profile-work', [{ name: 'sessionKey', value: 'sk-ant-secret' }]);
    mgr.impl.claudeConfig = (cfg, f) => ({ account: 'alice@example.com', trusted: f === folder, remoteAccepted: true });
    const { profiles, home, marks } = await h.editorCall(h.win(), 'list');
    assert.equal(home, sb.home);
    assert.deepEqual(marks, {});
    assert.deepEqual(profiles[0], {
      id: 'work', kind: 'code', name: 'Work', account: 'alice@example.com', url: 'https://claude.ai/code', configDir: '~/.claude-work', icon: null,
      shareSignIn: null, shareName: null, webSignedIn: true, cliAccount: 'alice@example.com', remoteAccepted: true, design: null,
      folders: [{ folder, display: folder, key: 'work-app', trusted: true }],
    });
    assert.equal(profiles[1].kind, 'design');
    assert.equal(profiles[1].url, 'https://claude.ai/design');
    assert.equal(profiles[1].shareName, 'Work');
    assert.equal(profiles[1].webSignedIn, true, 'a shared sign-in reads the other profile’s cookies');
    assert.equal(profiles[1].cliAccount, null);
    assert.doesNotMatch(JSON.stringify(profiles), /sk-ant-secret/);
    assert.deepEqual(callsOf('claudeConfig')[0], [path.join(sb.home, '.claude-work')]);
  });
  test('list offers custom marks from the data folder, with scripts removed', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    fs.mkdirSync(h.file('marks'), { recursive: true });
    fs.writeFileSync(h.file('marks', 'code.svg'), '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><script>alert(1)</script><path d="M0 0h24v24z"/><SCRIPT type="x">bad()</SCRIPT></svg>');
    fs.writeFileSync(h.file('marks', 'design.svg'), '<svg width="10"><path/></svg>');
    const { marks } = await h.editorCall(h.win(), 'list');
    assert.deepEqual(marks, { code: { viewBox: '0 0 24 24', inner: '<path d="M0 0h24v24z"/>' } }, 'a mark with no viewBox is skipped');
  });
  test('save creates a profile and every window picks it up', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    const w = h.win();
    const id = await h.editorCall(w, 'save', { name: 'Side Project', account: 'bob@example.com', folders: [] });
    assert.equal(id, 'side-project');
    assert.deepEqual(sb.readJson(h.file('profiles.json')).profiles.map((p) => p.id), ['work', 'side-project']);
    assert.ok(h.sidebarOf(w).webContents.sentOn('profiles-changed').length >= 1);
    assert.ok(h.menuItem('Profiles', 'Side Project (bob@example.com)'));
  });
  test('save passes on validation errors', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    await assert.rejects(h.editorCall(h.win(), 'save', { name: 'X', account: 'nope', folders: [] }), /email address/);
  });
  test('save stops the servers of folders the profile no longer has', async (t) => {
    const a = sb.dir('a');
    const b = sb.dir('b');
    const h = await loadMain(t, { profiles: [{ ...WORK, servers: [{ id: 'a', folder: a }, { id: 'b', folder: b }] }] });
    await h.editorCall(h.win(), 'save', { id: 'work', name: 'Work', account: 'alice@example.com', folders: [b] });
    assert.deepEqual(callsOf('stopServer'), [['work-a']]);
    await h.editorCall(h.win(), 'save', { id: 'work', kind: 'design', name: 'Work', account: 'alice@example.com', folders: [] });
    assert.deepEqual(callsOf('stopServer'), [['work-a'], ['work-b']], 'becoming a Design profile stops them all');
  });
  test('a server that fails to stop does not block the save', async (t) => {
    const a = sb.dir('a');
    const h = await loadMain(t, { profiles: [{ ...WORK, servers: [{ id: 'a', folder: a }] }] });
    mgr.impl.stopServer = async () => { throw new Error('launchctl failed'); };
    assert.equal(await h.editorCall(h.win(), 'save', { id: 'work', name: 'Work', account: 'alice@example.com', folders: [] }), 'work');
  });
  test('save stores a chosen or generated icon as a 256px PNG in the data folder', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    const src = path.join(sb.dir(), 'pic.heic');
    fe.state.images.set(src, 'full');
    await h.editorCall(h.win(), 'save', { id: 'work', name: 'Work', account: 'alice@example.com', folders: [], iconSource: src });
    assert.equal(fs.readFileSync(h.file('icons', 'work.png'), 'utf8'), 'PNG full 256x256');
    assert.equal(sb.readJson(h.file('profiles.json')).profiles[0].icon, 'icons/work.png');
    await h.editorCall(h.win(), 'save', { name: 'Gen', account: 'g@example.com', folders: [], iconDataUrl: 'data:image/png;base64,AAAA' });
    assert.ok(fs.existsSync(h.file('icons', 'gen.png')));
  });
  test('save rejects icon data that is not a PNG data URL, or an unreadable image', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    for (const iconDataUrl of ['data:image/svg+xml;base64,PHN2Zz4=', 'https://evil.example/x.png', 'data:text/html;base64,AAAA']) {
      await assert.rejects(h.editorCall(h.win(), 'save', { id: 'work', name: 'Work', account: 'alice@example.com', folders: [], iconDataUrl }), /Unexpected icon data/);
    }
    await assert.rejects(h.editorCall(h.win(), 'save', { id: 'work', name: 'Work', account: 'alice@example.com', folders: [], iconSource: '/not/an/image.txt' }), /could not be read as an image/);
    assert.ok(!fs.existsSync(h.file('icons')));
  });
  test('removeIcon clears the icon', async (t) => {
    const h = await loadMain(t, { profiles: [{ ...WORK, icon: 'icons/work.png' }] });
    await h.editorCall(h.win(), 'save', { id: 'work', name: 'Work', account: 'alice@example.com', folders: [], removeIcon: true });
    assert.equal(sb.readJson(h.file('profiles.json')).profiles[0].icon, undefined);
  });
  test('remove stops the profile’s servers, deletes it and moves windows off it', async (t) => {
    const h = await loadMain(t, { profiles: [{ ...WORK, servers: [{ id: 'a', folder: '/x' }] }, HOME] });
    const w = h.win();
    const workPage = h.viewFor(w, 'work').webContents;
    await h.editorCall(w, 'remove', 'work');
    assert.deepEqual(callsOf('stopServer'), [['work-a']]);
    assert.deepEqual(sb.readJson(h.file('profiles.json')).profiles.map((p) => p.id), ['home']);
    assert.equal(workPage.destroyed, true);
    assert.equal(h.viewFor(w, 'work'), undefined);
    assert.equal(h.activeId(w), '__profiles', 'the Profiles screen stays open where the person removed it');
  });
  test('removing the profile a window shows sends that window to the first profile', async (t) => {
    const h = await loadMain(t, { profiles: [WORK, HOME], saved: { windows: [{ activeId: 'work' }, { activeId: 'home' }] } });
    await h.editorCall(h.win(0), 'remove', 'home');
    assert.equal(h.activeId(h.win(1)), 'work');
  });
  test('remove refuses a profile another one shares a sign-in with', async (t) => {
    const h = await loadMain(t, { profiles: [WORK, DESIGN] });
    await assert.rejects(h.editorCall(h.win(), 'remove', 'work'), /Work Design shares this profile’s sign-in/);
  });
  test('cliLogin and trustFolder open Terminal with the profile’s config, safely quoted', async (t) => {
    const folder = path.join(sb.dir(), "Bob's \"code\" $HOME `x`");
    fs.mkdirSync(folder);
    const h = await loadMain(t, { profiles: [{ ...WORK, servers: [{ id: 'a', folder }] }] });
    fakeCp.on('osascript', '');
    const cfg = path.join(sb.home, '.claude-work');
    assert.deepEqual(await h.editorCall(h.win(), 'cliLogin', 'work'), { ran: true, command: `CLAUDE_CONFIG_DIR='${cfg}' claude` });
    const r = await h.editorCall(h.win(), 'trustFolder', 'work', folder);
    assert.equal(r.command, `cd '${folder.replace(/'/g, `'\\''`)}' && CLAUDE_CONFIG_DIR='${cfg}' claude remote-control`);
    const script = fakeCp.callsTo('osascript').at(-1).args[3];
    assert.ok(script.startsWith('tell application "Terminal" to do script "'));
    const quoted = script.slice('tell application "Terminal" to do script '.length);
    assert.equal(JSON.parse(quoted), r.command, 'AppleScript string escaping round-trips the command');
  });
  test('when the app may not drive Terminal, the command is copied instead', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    fakeCp.on('osascript', () => fakeCp.fail('Not authorized to send Apple events to Terminal.'));
    const cfg = path.join(sb.home, '.claude-work');
    assert.deepEqual(await h.editorCall(h.win(), 'cliLogin', 'work'), { ran: false, copied: true, command: `CLAUDE_CONFIG_DIR='${cfg}' claude` });
    assert.equal(fe.state.clipboard, `CLAUDE_CONFIG_DIR='${cfg}' claude`);
  });
  test('folder, config folder and icon pickers', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    const w = h.win();
    assert.deepEqual(await h.editorCall(w, 'chooseFolders'), []);
    assert.deepEqual(fe.state.openDialogs[0].properties, ['openDirectory', 'multiSelections', 'createDirectory']);
    fe.state.openDialogResult = { canceled: false, filePaths: ['/a', '/b'] };
    assert.deepEqual(await h.editorCall(w, 'chooseFolders'), ['/a', '/b']);
    assert.equal(await h.editorCall(w, 'chooseConfigDir'), '/a');
    assert.ok(fe.state.openDialogs[2].properties.includes('showHiddenFiles'));
    fe.state.openDialogResult = { canceled: true, filePaths: [] };
    assert.equal(await h.editorCall(w, 'chooseConfigDir'), null);
    assert.equal(await h.editorCall(w, 'chooseIcon'), null);
    fe.state.openDialogResult = { canceled: false, filePaths: ['/pics/me.png'] };
    await assert.rejects(h.editorCall(w, 'chooseIcon'), /could not be read as an image/);
    fe.state.images.set('/pics/me.png', 'full');
    const icon = await h.editorCall(w, 'chooseIcon');
    assert.equal(icon.source, '/pics/me.png');
    assert.match(icon.preview, /^data:image\/png;base64,/);
  });
  test('openProfile and openServers switch the window', async (t) => {
    const h = await loadMain(t, { profiles: [WORK, HOME] });
    const w = h.win();
    await h.editorCall(w, 'openProfile', 'home');
    assert.equal(h.activeId(w), 'home');
    await h.editorCall(w, 'openServers');
    assert.equal(h.activeId(w), '__servers');
  });
});

describe('Claude Design access', () => {
  const STATUS = { available: true, signed_in: false, can_sign_in_here: true };
  test('the list shows a Claude Code profile’s state once checked, and checks again only every few minutes', async (t) => {
    const h = await loadMain(t, { profiles: [WORK, DESIGN], now: 1_000_000 });
    mgr.impl.designStatus = async () => ({ ...STATUS, signed_in: true });
    let { profiles } = await h.editorCall(h.win(), 'list');
    assert.equal(profiles[0].design, null, 'still checking');
    assert.equal(profiles[1].design, null, 'a Design profile has nothing to authorize');
    await settle();
    ({ profiles } = await h.editorCall(h.win(), 'list'));
    assert.deepEqual(profiles[0].design, { ...STATUS, signed_in: true });
    assert.deepEqual(callsOf('designStatus'), [[path.join(sb.home, '.claude-work')]]);
    t.mock.timers.tick(5 * 60000 + 1);
    mgr.impl.designStatus = async () => { throw new Error('claude not found on PATH'); };
    ({ profiles } = await h.editorCall(h.win(), 'list'));
    assert.equal(profiles[0].design.signed_in, true, 'the last answer stands while the next check runs');
    await settle();
    ({ profiles } = await h.editorCall(h.win(), 'list'));
    assert.deepEqual(profiles[0].design, { error: 'claude not found on PATH' });
    assert.equal(callsOf('designStatus').length, 2);
  });
  function fakeLogin(url = 'https://claude.com/cai/oauth/authorize?x=1') {
    const login = { cancelled: 0, cancel() { this.cancelled++; } };
    login.done = new Promise((r) => { login.finish = r; });
    mgr.impl.designLogin = async (_cfg, onUrl) => { if (url) onUrl(url); return login; };
    return login;
  }
  test('Authorize opens Claude’s approval page on the profile’s own sign-in, then closes it and checks again', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    const login = fakeLogin();
    let result;
    const p = h.editorCall(h.win(), 'designLogin', 'work').then((r) => { result = r; });
    await settle();
    assert.equal(callsOf('designLogin')[0][0], path.join(sb.home, '.claude-work'));
    const win = fe.state.windows.find((x) => x instanceof fe.electron.BrowserWindow);
    assert.equal(win.opts.title, 'Work · Claude Design');
    assert.equal(win.webContents.session.partition, 'persist:profile-work', 'the profile’s account approves it');
    assert.equal(win.webContents.prefs.sandbox, true);
    assert.deepEqual(win.webContents.loads, ['https://claude.com/cai/oauth/authorize?x=1']);
    assert.deepEqual(fe.state.externals, [], 'never the default browser, which may be signed in to another account');
    assert.equal(result, undefined, 'waits for the approval');
    mgr.impl.designStatus = async () => ({ ...STATUS, signed_in: true });
    login.finish({ ok: true, message: '' });
    await p;
    assert.deepEqual(result, { ok: true, message: '' });
    assert.equal(win.destroyed, true);
    const { profiles } = await h.editorCall(h.win(), 'list');
    assert.equal(profiles[0].design.signed_in, true, 'checked again straight away');
  });
  test('closing the approval window cancels the sign-in', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    const login = fakeLogin();
    const p = h.editorCall(h.win(), 'designLogin', 'work');
    await settle();
    fe.state.windows.find((x) => x instanceof fe.electron.BrowserWindow).close();
    assert.equal(login.cancelled, 1);
    login.finish({ ok: false, message: 'The sign-in was cancelled.' });
    assert.deepEqual(await p, { ok: false, message: 'The sign-in was cancelled.' });
  });
  test('starting again replaces a sign-in under way', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    const first = fakeLogin(null);
    h.editorCall(h.win(), 'designLogin', 'work');
    await settle();
    fakeLogin(null);
    h.editorCall(h.win(), 'designLogin', 'work');
    await settle();
    assert.equal(first.cancelled, 1);
  });
  test('another profile’s sign-in can approve, and the list then says which account it was', async (t) => {
    const h = await loadMain(t, { profiles: [WORK, HOME] });
    const login = fakeLogin();
    const p = h.editorCall(h.win(), 'designLogin', 'work', 'home');
    await settle();
    assert.equal(callsOf('designLogin')[0][0], path.join(sb.home, '.claude-work'), 'saved for the Work profile’s sessions');
    const win = fe.state.windows.find((x) => x instanceof fe.electron.BrowserWindow);
    assert.equal(win.webContents.session.partition, 'persist:profile-home', 'approved by the Home account');
    assert.equal(win.opts.title, 'Home · Claude Design');
    mgr.impl.designStatus = async () => ({ ...STATUS, signed_in: true });
    login.finish({ ok: true, message: '' });
    await p;
    const saved = JSON.parse(fs.readFileSync(h.file('state', 'design-approvals.json'), 'utf8'))[path.join(sb.home, '.claude-work')];
    assert.equal(saved.account, 'alice@home.example');
    assert.equal(saved.profile, 'home');
    let { profiles } = await h.editorCall(h.win(), 'list');
    assert.equal(profiles[0].design.approvedAs, 'alice@home.example');
    assert.equal(profiles[1].design?.approvedAs, undefined, 'Home itself was not authorized');
    // Approving again with the profile's own sign-in replaces it: the way out of the wrong account.
    fakeLogin().finish({ ok: true, message: '' });
    await h.editorCall(h.win(), 'designLogin', 'work', 'work');
    ({ profiles } = await h.editorCall(h.win(), 'list'));
    assert.equal(profiles[0].design.approvedAs, 'alice@example.com');
  });
  test('a failed or cancelled approval leaves the recorded account alone', async (t) => {
    const h = await loadMain(t, { profiles: [WORK, HOME] });
    fakeLogin().finish({ ok: false, message: 'The sign-in was cancelled.' });
    await h.editorCall(h.win(), 'designLogin', 'work', 'home');
    assert.equal(fs.existsSync(h.file('state', 'design-approvals.json')), false);
  });
  test('the account is shown only while the profile is authorized', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    fs.mkdirSync(h.file('state'), { recursive: true });
    fs.writeFileSync(h.file('state', 'design-approvals.json'), JSON.stringify({ [path.join(sb.home, '.claude-work')]: { account: 'alice@example.com' } }));
    await h.editorCall(h.win(), 'list');
    await settle();
    const { profiles } = await h.editorCall(h.win(), 'list');
    assert.deepEqual(profiles[0].design, STATUS, 'signed out (in Terminal, say): no account');
  });
  test('an approving sign-in that is gone is refused', async (t) => {
    const h = await loadMain(t, { profiles: [WORK] });
    await assert.rejects(h.editorCall(h.win(), 'designLogin', 'work', 'deleted'), /That sign-in is no longer in the app/);
    assert.equal(callsOf('designLogin').length, 0);
  });
  test('only a Claude Code profile can authorize', async (t) => {
    const h = await loadMain(t, { profiles: [WORK, DESIGN] });
    await assert.rejects(h.editorCall(h.win(), 'designLogin', 'work-design'), /Only a Claude Code profile can authorize Claude Design/);
    await assert.rejects(h.editorCall(h.win(), 'designLogin', 'deleted'), /Only a Claude Code profile can authorize Claude Design/);
    assert.equal(callsOf('designLogin').length, 0);
  });
});
