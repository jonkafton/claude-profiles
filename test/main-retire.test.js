'use strict';
const { sb, fe, mgr, callsOf, loadMain, settle } = require('./helpers/main-fixture');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');

const WORK = { id: 'work', name: 'Work', account: 'alice@example.com', configDir: '~/.claude-work', servers: [] };
const HOME = { id: 'home', name: 'Home', account: 'alice@home.example', configDir: '~/.claude-home' };
const DESIGN = { id: 'work-design', kind: 'design', name: 'Work Design', account: 'alice@example.com', shareSignIn: 'work' };
const MACHINE = os.hostname().replace(/\.local$/, '');
const ENVS = 'https://claude.ai/v1/environment_providers/private/organizations/org1/environments';
const SETTINGS = 'https://claude.ai/api/claude_code/organizations/org1/user_settings';
const STARRED = 'ccd/epitaxy-starred-environments';
const PRESETS = 'ccd/session-presets';

const env = (id, { folder = '/code/app', online = false, machine = MACHINE, kind = 'bridge', state = 'active' } = {}) => ({ environment_id: id, kind, state, bridge_info: { machine_name: machine, directory: folder, online } });

async function setup(t, { envs, entries, composer, retired, servers } = {}) {
  const h = await loadMain(t, { profiles: [WORK, HOME, DESIGN] });
  if (retired) sb.writeJson(h.file('state', 'retired-environments.json'), retired);
  mgr.impl.status = async () => ({ servers: servers || [
    { profileId: 'work', pid: 5, folder: '/code/app', sessions: [], terminal: [] },
    { profileId: 'work', pid: null, folder: '/code/stopped', sessions: [], terminal: [] },
    { profileId: 'home', pid: null, folder: '/code/home', sessions: [], terminal: [] },
  ], unmanaged: [] });
  const logs = [];
  mgr.impl.log = (line) => logs.push(line);
  fe.route('GET', 'https://claude.ai/api/organizations', [{ uuid: 'org1' }]);
  fe.route('GET', `${ENVS}?limit=1000`, { environments: envs || [
    env('env_live', { online: true }),
    env('env_dead'),
    env('env_dead2'),
    env('env_other_machine', { machine: 'someone-elses-mac' }),
    env('env_other_folder', { folder: '/code/stopped' }),
    env('env_archived', { state: 'archived' }),
    env('env_cloud', { kind: 'anthropic_cloud' }),
  ] });
  fe.route('POST', /\/environments\/env_dead\/archive$/, {});
  fe.route('POST', /\/environments\/env_dead2\/archive$/, () => fe.json({ error: 'busy' }, 500));
  fe.route('GET', SETTINGS, { content: { entries: entries || {
    [STARRED]: JSON.stringify({ state: { starredIds: ['bridge:env_dead', 'bridge:env_live', 'cloud:abc', 'bridge:env_unrelated'] }, version: 1 }),
    [PRESETS]: JSON.stringify({ state: { placeDefaults: { 'bridge:env_dead': { model: 'opus' }, 'bridge:env_dead2': { model: 'x' }, 'bridge:env_live': { model: 'keep' } } }, version: 2 }),
    unrelated: 'leave me',
  } } });
  let put = null;
  fe.route('PUT', SETTINGS, (_u, opts) => { put = JSON.parse(opts.body); return {}; });
  fe.state.localStorage.set('persist:profile-work', new Map(composer === undefined
    ? [['ccd-session-store', JSON.stringify({ state: { worker: { type: 'environment', id: 'env_dead' }, currentHostKey: 'cloud', draft: 'hi' }, version: 3 })]]
    : composer));
  const run = async () => { t.mock.timers.tick(60000); await settle(60); };
  return { h, logs, put: () => put, run };
}
const archived = () => fe.state.fetches.filter((f) => f.method === 'POST' && f.url.endsWith('/archive')).map((f) => f.url.split('/').at(-2));

describe('retiring stale Remote Control environments', () => {
  test('archives only this Mac’s offline environments for folders whose server is online', async (t) => {
    const { h, logs, run } = await setup(t);
    await run();
    assert.deepEqual(archived().sort(), ['env_dead', 'env_dead2']);
    const retired = sb.readJson(h.file('state', 'retired-environments.json'));
    assert.deepEqual(Object.keys(retired), ['env_dead'], 'a failed archive is not recorded');
    assert.equal(retired.env_dead.profileId, 'work');
    assert.equal(retired.env_dead.folder, '/code/app');
    assert.ok(logs.some((l) => l === 'archived stale environment env_dead for /code/app in Work'));
    assert.ok(logs.some((l) => l === 'could not archive (500) stale environment env_dead2 for /code/app in Work'));
  });
  test('uses each profile’s own sign-in, skipping shared sign-ins and profiles with nothing running', async (t) => {
    const { run } = await setup(t);
    await run();
    const partitions = new Set(fe.state.fetches.filter((f) => f.url.includes('claude.ai/api/organizations')).map((f) => f.partition));
    assert.deepEqual([...partitions], ['persist:profile-work']);
  });
  test('points new sessions at the live environment before archiving, and reloads an open new-session screen', async (t) => {
    const { h, logs, run } = await setup(t);
    const w = h.win();
    const work = h.viewFor(w, 'work').webContents;
    work.url = 'https://claude.ai/code';
    await run();
    const store = JSON.parse(fe.state.localStorage.get('persist:profile-work').get('ccd-session-store'));
    assert.deepEqual(store, { state: { worker: { type: 'environment', id: 'env_live' }, currentHostKey: 'bridge', draft: 'hi' }, version: 3 });
    assert.equal(work.reloads, 1);
    assert.ok(logs.includes('new sessions in Work now open on env_live'));
    const hidden = fe.state.windows.find((x) => x instanceof fe.electron.BrowserWindow && x.opts.show === false);
    assert.deepEqual(hidden.webContents.loads, ['https://claude.ai/robots.txt'], 'a page that does not start the web app');
    assert.equal(hidden.destroyed, true);
    const firstArchive = fe.state.fetches.findIndex((f) => f.url.endsWith('/archive'));
    const firstEnvList = fe.state.fetches.findIndex((f) => f.url === `${ENVS}?limit=1000`);
    assert.ok(firstEnvList < firstArchive);
  });
  test('leaves a session page alone, and a composer already on a live environment', async (t) => {
    const { h, logs, run } = await setup(t, { composer: [['ccd-session-store', JSON.stringify({ state: { worker: { type: 'environment', id: 'env_live' } } })]] });
    const work = h.viewFor(h.win(), 'work').webContents;
    work.url = 'https://claude.ai/code/session_123';
    await run();
    assert.equal(work.reloads, 0);
    assert.ok(!logs.some((l) => l.startsWith('new sessions in')));
  });
  test('carries stars and per-place defaults over to the live environment, changing nothing else', async (t) => {
    const { put, run } = await setup(t);
    await run();
    const body = put();
    assert.deepEqual(Object.keys(body.entries).sort(), [STARRED, PRESETS].sort());
    const starred = JSON.parse(body.entries[STARRED]);
    assert.deepEqual(starred.state.starredIds, ['bridge:env_live', 'cloud:abc', 'bridge:env_unrelated']);
    assert.equal(starred.version, 1);
    assert.equal(typeof starred.updatedAt, 'number');
    const presets = JSON.parse(body.entries[PRESETS]);
    assert.deepEqual(presets.state.placeDefaults, { 'bridge:env_live': { model: 'keep' } }, 'the live environment keeps its own defaults');
    assert.equal(presets.version, 2);
  });
  test('a dead environment’s defaults move to a live environment that had none', async (t) => {
    const { put, run } = await setup(t, { entries: { [PRESETS]: JSON.stringify({ state: { placeDefaults: { 'bridge:env_dead': { model: 'opus' } } } }) } });
    await run();
    assert.deepEqual(JSON.parse(put().entries[PRESETS]).state.placeDefaults, { 'bridge:env_live': { model: 'opus' } });
  });
  test('sends nothing when no setting names a dead environment', async (t) => {
    const { put, run } = await setup(t, { entries: { [STARRED]: JSON.stringify({ state: { starredIds: ['cloud:abc'] } }), [PRESETS]: 'not json' } });
    await run();
    assert.equal(put(), null);
  });
  test('an environment retired earlier is still remapped once claude.ai no longer lists it', async (t) => {
    const { put, run } = await setup(t, {
      envs: [env('env_live', { online: true })],
      retired: { env_old: { profileId: 'work', folder: '/code/app', at: '2026-10-01T00:00:00Z' }, env_elsewhere: { profileId: 'home', folder: '/code/app' } },
      entries: { [STARRED]: JSON.stringify({ state: { starredIds: ['bridge:env_old', 'bridge:env_elsewhere'] } }) },
      composer: [['ccd-session-store', JSON.stringify({ state: { worker: { type: 'environment', id: 'env_old' } } })]],
    });
    await run();
    assert.deepEqual(archived(), []);
    assert.deepEqual(JSON.parse(put().entries[STARRED]).state.starredIds, ['bridge:env_live', 'bridge:env_elsewhere'], 'another profile’s retired environment is left alone');
    assert.equal(JSON.parse(fe.state.localStorage.get('persist:profile-work').get('ccd-session-store')).state.worker.id, 'env_live');
  });
  test('does nothing for a folder with no live environment yet', async (t) => {
    const { put, run } = await setup(t, { envs: [env('env_dead'), env('env_dead2')] });
    await run();
    assert.deepEqual(archived(), []);
    assert.equal(put(), null);
    assert.equal(fe.state.windows.filter((x) => x instanceof fe.electron.BrowserWindow).length, 0);
  });
  test('a profile signed out of claude.ai is logged and skipped', async (t) => {
    const { logs, run } = await setup(t);
    fe.route('GET', 'https://claude.ai/api/organizations', () => new Response('<html>login</html>', { status: 401 }));
    await run();
    assert.ok(logs.some((l) => l.startsWith('retiring stale environments in Work: ')));
    assert.deepEqual(archived(), []);
  });
  test('an organization whose environment list fails is skipped', async (t) => {
    const { run } = await setup(t);
    fe.route('GET', `${ENVS}?limit=1000`, () => fe.json({}, 403));
    await run();
    assert.deepEqual(archived(), []);
  });
  test('a composer page that never reaches claude.ai is logged and the rest carries on', async (t) => {
    const { logs, put, run } = await setup(t);
    const BW = fe.electron.BrowserWindow;
    const load = BW.prototype.loadURL;
    BW.prototype.loadURL = function () { this.webContents.url = 'chrome-error://chromewebdata/'; return Promise.reject(new Error('ERR_INTERNET_DISCONNECTED')); };
    t.after(() => { BW.prototype.loadURL = load; });
    t.mock.timers.tick(60000);
    for (let i = 0; i < 5; i++) { await settle(10); t.mock.timers.tick(1000); }
    await settle(40);
    assert.ok(logs.includes('could not repoint new sessions in Work: could not open a claude.ai page'));
    assert.deepEqual(archived().sort(), ['env_dead', 'env_dead2']);
    assert.ok(put());
  });
  test('runs a minute after launch, every 30 minutes, and a minute after a server starts', async (t) => {
    const { h, run } = await setup(t);
    const lists = () => fe.state.fetches.filter((f) => f.url === `${ENVS}?limit=1000`).length;
    await run();
    assert.equal(lists(), 1);
    t.mock.timers.tick(30 * 60000 - 60000);
    await settle(60);
    assert.equal(lists(), 2);
    await h.mgrCall(h.win(), 'start', 'work-app');
    t.mock.timers.tick(59999);
    await settle(20);
    assert.equal(lists(), 2);
    t.mock.timers.tick(1);
    await settle(60);
    assert.equal(lists(), 3);
  });
  test('a manager status failure skips the pass', async (t) => {
    const { run } = await setup(t);
    mgr.impl.status = async () => { throw new Error('ps failed'); };
    await run();
    assert.equal(fe.state.fetches.filter((f) => f.url === `${ENVS}?limit=1000`).length, 0);
    assert.ok(callsOf('status').length > 0);
  });
});

test('retired-environments.json is created under the data folder’s state', async (t) => {
  const { h, run } = await setup(t);
  assert.ok(!fs.existsSync(h.file('state', 'retired-environments.json')));
  await run();
  assert.ok(fs.existsSync(h.file('state', 'retired-environments.json')));
});
