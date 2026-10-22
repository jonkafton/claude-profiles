'use strict';
const { sb, fe, mgr, loadMain, settle } = require('./helpers/main-fixture');
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const WORK = { id: 'work', name: 'Work', account: 'alice@example.com', configDir: '~/.claude-work', servers: [] };
const MACHINE = os.hostname().replace(/\.local$/, '');
const ENVS = 'https://claude.ai/v1/environment_providers/private/organizations/org1/environments';
const SESSIONS = 'https://claude.ai/v1/code/sessions?statuses=active&statuses=paused&limit=100';

const env = (id, { folder = '/code/app', online = true, max = 100 } = {}) => ({ environment_id: id, kind: 'bridge', state: 'active', bridge_info: { machine_name: MACHINE, directory: folder, online, max_sessions: max } });
// n sessions in env_live, quietest first: cse_0 has been quiet longest.
const sessions = (n, environmentId = 'env_live') => Array.from({ length: n }, (_, i) => ({
  id: `cse_${i}`, title: `Session ${i}`, environment_id: environmentId, session_status: 'idle', worker_status: 'idle',
  last_event_at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
}));

async function setup(t, { list = sessions(95), envs = [env('env_live')], live = [], kept = [], archiveFails = [] } = {}) {
  const h = await loadMain(t, { profiles: [WORK] });
  let status = { servers: [{ profileId: 'work', pid: 5, folder: '/code/app', sessions: live.map((id) => ({ sessionId: id, kept: false })), terminal: [] }], unmanaged: [] };
  mgr.impl.status = async () => status;
  mgr.impl.keptIds = () => kept;
  const logs = [];
  mgr.impl.log = (line) => logs.push(line);
  fe.route('GET', 'https://claude.ai/api/organizations', [{ uuid: 'org1' }]);
  fe.route('GET', `${ENVS}?limit=1000`, { environments: envs });
  // Two pages, to prove pagination.
  fe.route('GET', SESSIONS, (url) => (url.includes('after_id=')
    ? { data: list.slice(50), has_more: false }
    : { data: list.slice(0, 50), has_more: list.length > 50, last_id: list[Math.min(49, list.length - 1)]?.id }));
  fe.route('POST', /\/v1\/code\/sessions\/[^/]+\/archive$/, (url) => (archiveFails.includes(url.split('/').at(-2)) ? fe.json({}, 500) : {}));
  fe.route('POST', /\/v1\/code\/sessions\/[^/]+\/unarchive$/, {});
  const run = async (ms = 90000) => { t.mock.timers.tick(ms); await settle(80); };
  return { h, logs, run, setStatus: (s) => { status = s; } };
}
const posted = (what) => fe.state.fetches.filter((f) => f.method === 'POST' && f.url.endsWith(`/${what}`)).map((f) => f.url.split('/').at(-2));

describe('making room on a full server', () => {
  test('at 95 of 100 archives the 5 sessions quiet longest, with claude.ai’s session headers', async (t) => {
    const { h, logs, run } = await setup(t);
    await run();
    assert.deepEqual(posted('archive'), ['cse_0', 'cse_1', 'cse_2', 'cse_3', 'cse_4']);
    const req = fe.state.fetches.find((f) => f.url.endsWith('/archive'));
    assert.equal(req.headers['x-organization-uuid'], 'org1');
    assert.equal(req.headers['anthropic-beta'], 'ccr-byoc-2025-07-29');
    const record = sb.readJson(h.file('state', 'archived-sessions.json'));
    assert.deepEqual(Object.keys(record).sort(), ['cse_0', 'cse_1', 'cse_2', 'cse_3', 'cse_4']);
    assert.equal(record.cse_0.profileId, 'work');
    assert.ok(logs.some((l) => l.includes('had 95 of 100 places used: archived 5')));
  });
  test('below 95 archives nothing', async (t) => {
    const { run } = await setup(t, { list: sessions(94) });
    await run();
    assert.deepEqual(posted('archive'), []);
  });
  test('uses the server’s own limit', async (t) => {
    const { run } = await setup(t, { list: sessions(27), envs: [env('env_live', { max: 32 })] });
    await run();
    assert.deepEqual(posted('archive'), ['cse_0', 'cse_1', 'cse_2', 'cse_3', 'cse_4']);
  });
  test('over the line, archives enough to get back under it', async (t) => {
    const { run } = await setup(t, { list: sessions(100) });
    await run();
    assert.equal(posted('archive').length, 6);
  });
  test('never archives a session running here, kept, or working on claude.ai', async (t) => {
    const list = sessions(95);
    list[2].worker_status = 'running';
    list[3].worker_status = 'requires_action';
    const { run } = await setup(t, { list, live: ['cse_0'], kept: ['cse_1'] });
    await run();
    assert.deepEqual(posted('archive'), ['cse_4', 'cse_5', 'cse_6', 'cse_7', 'cse_8']);
  });
  test('counts only this server’s environment, and leaves offline and other folders alone', async (t) => {
    const { run } = await setup(t, {
      list: [...sessions(60), ...sessions(60, 'env_other').map((s) => ({ ...s, id: `${s.id}_o` }))],
      envs: [env('env_live'), env('env_other', { folder: '/code/elsewhere' })],
    });
    await run();
    assert.deepEqual(posted('archive'), []);
  });
  test('a failed archive is logged and not recorded', async (t) => {
    const { h, logs, run } = await setup(t, { archiveFails: ['cse_1'] });
    await run();
    assert.ok(!('cse_1' in sb.readJson(h.file('state', 'archived-sessions.json'))));
    assert.ok(logs.some((l) => l.includes('could not archive session cse_1 (500)')));
  });
  test('reloads an open new-session screen once room is made', async (t) => {
    const { h, run } = await setup(t);
    const view = h.viewFor(h.win(), 'work');
    view.webContents.url = 'https://claude.ai/code';
    await run();
    assert.equal(view.webContents.reloads, 1);
  });
});

describe('when to make room', () => {
  test('opening the new-session screen checks straight away, at most once a minute', async (t) => {
    const { h, run } = await setup(t, { list: sessions(10) });
    await run(); // the launch pass
    const lists = () => fe.state.fetches.filter((f) => f.url.startsWith(SESSIONS) && !f.url.includes('after_id') && f.headers?.['x-organization-uuid']).length;
    assert.equal(lists(), 1);
    const view = h.viewFor(h.win(), 'work');
    view.webContents.navigate('https://claude.ai/code');
    await run(0);
    assert.equal(lists(), 1, 'within a minute of the last pass');
    await run(60000);
    assert.equal(lists(), 2);
    view.webContents.navigateInPage('https://claude.ai/code/session_abc');
    await run(60000);
    assert.equal(lists(), 2, 'a session page is not the new-session screen');
  });
  test('a session starting on a server checks', async (t) => {
    const { run, setStatus } = await setup(t, { list: sessions(10) });
    await run(); // the launch pass, with the first status already taken
    const lists = () => fe.state.fetches.filter((f) => f.url.startsWith(SESSIONS) && !f.url.includes('after_id') && f.headers?.['x-organization-uuid']).length;
    const before = lists();
    setStatus({ servers: [{ profileId: 'work', pid: 5, folder: '/code/app', sessions: [{ sessionId: 'cse_new' }], terminal: [] }], unmanaged: [] });
    await run(30000); // the next status refresh notices it
    await run(60000);
    assert.equal(lists(), before + 1);
  });
});

describe('opening a session the app archived', () => {
  test('unarchives it, forgets it and reloads the page', async (t) => {
    const { h } = await setup(t);
    sb.writeJson(h.file('state', 'archived-sessions.json'), { cse_01abc: { profileId: 'work', org: 'org1' } });
    const view = h.viewFor(h.win(), 'work');
    view.webContents.navigate('https://claude.ai/code/session_01abc');
    await settle(40);
    assert.deepEqual(posted('unarchive'), ['cse_01abc']);
    assert.equal(fe.state.fetches.find((f) => f.url.endsWith('/unarchive')).headers['x-organization-uuid'], 'org1');
    assert.deepEqual(sb.readJson(h.file('state', 'archived-sessions.json')), {});
    assert.equal(view.webContents.reloads, 1);
  });
  test('leaves sessions it did not archive alone', async (t) => {
    const { h } = await setup(t);
    sb.writeJson(h.file('state', 'archived-sessions.json'), { cse_01abc: { profileId: 'someone-else', org: 'org1' } });
    const view = h.viewFor(h.win(), 'work');
    view.webContents.navigate('https://claude.ai/code/session_01abc');
    view.webContents.navigate('https://claude.ai/code/session_01xyz');
    await settle(40);
    assert.deepEqual(posted('unarchive'), []);
  });
});
