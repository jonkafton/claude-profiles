'use strict';
const { sb, fake, makeManager, oneServer, label } = require('./helpers/manager-fixture');
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

beforeEach(() => fake.reset());

const CLAUDE = '/Users/x/.local/bin/claude';
const server = (pid, prefix, extra = {}) => ({ pid, ppid: 1, cmd: `${CLAUDE} remote-control${prefix ? ` --remote-control-session-name-prefix ${prefix}` : ''}`, ...extra });
const rcSession = (pid, serverPid, sessionId, extra = {}) => ({ pid, ppid: serverPid, cmd: `${CLAUDE} --print --sdk-url wss://x --session-id ${sessionId} --output-format stream-json`, ...extra });
const child = (pid, ppid, extra = {}) => ({ pid, ppid, cmd: 'node mcp-server.js', rss: 0, ...extra });

describe('status()', () => {
  test('a configured server that is not running', async () => {
    const { mgr, key, folder, cfg } = oneServer();
    const st = await mgr.status();
    assert.deepEqual(st.servers, [{
      key, profileId: 'work', profileName: 'Work', expectedAccount: 'alice@example.com', folder, configDir: cfg,
      problem: null, account: 'alice@example.com', loaded: false, pid: null, sessions: [], rssMB: 0, terminal: [],
    }]);
    assert.deepEqual(st.unmanaged, []);
    assert.deepEqual(st.desktop, { count: 0, rssMB: 0 });
    assert.deepEqual(st.cleanup, { idleHours: 3, idleCpuPerHour: 30, includeDesktop: false, enabled: false, loaded: false });
  });
  test('a running managed server with its sessions, memory and loaded state', async () => {
    const { mgr, key, folder, cfg } = oneServer();
    fake.state.loaded.add(label(key));
    fake.state.processes.push(
      server(100, key, { cwd: folder, configDir: cfg }),
      rcSession(200, 100, 'cse_one', { rss: 200 * 1024 }),
      child(201, 200, { rss: 56 * 1024 }),
      rcSession(300, 100, 'cse_two', { rss: 100 * 1024 }),
      { pid: 400, ppid: 100, cmd: 'something else the server runs' },
    );
    const [s] = (await mgr.status()).servers;
    assert.equal(s.loaded, true);
    assert.equal(s.pid, 100);
    assert.deepEqual(s.sessions, [
      { pid: 200, sessionId: 'cse_one', rssMB: 256, idleHours: null, kept: false },
      { pid: 300, sessionId: 'cse_two', rssMB: 100, idleHours: null, kept: false },
    ]);
    assert.equal(s.rssMB, 356);
    assert.deepEqual(s.terminal, []);
  });
  test('a hand-started server in the same folder and config shows as a Terminal server, not unmanaged', async () => {
    const { mgr, folder, cfg } = oneServer();
    fake.state.processes.push(
      server(110, null, { cwd: folder, configDir: cfg }),
      rcSession(210, 110, 'cse_term'),
      server(120, null, { cwd: folder, configDir: '/other/config' }),
      server(130, null, { cwd: '/elsewhere' }),
    );
    const st = await mgr.status();
    assert.equal(st.servers[0].pid, null);
    assert.deepEqual(st.servers[0].terminal.map((t) => ({ pid: t.pid, sessions: t.sessions.map((x) => x.sessionId) })), [{ pid: 110, sessions: ['cse_term'] }]);
    assert.deepEqual(st.unmanaged.map((u) => [u.pid, u.cwd, u.configDir]), [
      [120, folder, '/other/config'],
      [130, '/elsewhere', path.join(sb.home, '.claude')],
    ]);
  });
  test('a server whose prefix names another configured key is not treated as this folder’s Terminal server', async () => {
    const folder = sb.dir('folder');
    const cfg = sb.claudeConfigDir({ trusted: [folder] });
    const { mgr } = makeManager({ profiles: [{ id: 'p', name: 'P', configDir: cfg, servers: [{ id: 'a', folder }, { id: 'b', folder }] }] });
    fake.state.processes.push(server(100, 'p-b', { cwd: folder, configDir: cfg }));
    const st = await mgr.status();
    assert.equal(st.servers[0].pid, null);
    assert.deepEqual(st.servers[0].terminal, []);
    assert.equal(st.servers[1].pid, 100);
  });
  test('flags an untrusted folder as a problem', async () => {
    const folder = sb.dir('folder');
    const cfg = sb.claudeConfigDir({ trusted: [] });
    const { mgr } = makeManager({ profiles: [{ id: 'p', name: 'P', configDir: cfg, servers: [{ id: 's', folder }] }] });
    assert.equal((await mgr.status()).servers[0].problem, 'folder not trusted for this profile');
  });
  test('counts Claude desktop app sessions and their memory', async () => {
    const { mgr } = oneServer();
    fake.state.processes.push(
      { pid: 700, ppid: 1, cmd: '/Applications/Claude.app/Contents/Helpers/disclaimer /x/claude' },
      { pid: 701, ppid: 700, cmd: `${CLAUDE} --output-format stream-json --verbose`, rss: 300 * 1024 },
      { pid: 702, ppid: 700, cmd: `${CLAUDE} --output-format stream-json --verbose`, rss: 212 * 1024 },
      { pid: 703, ppid: 700, cmd: `${CLAUDE} --print`, rss: 999 * 1024 },
    );
    assert.deepEqual((await mgr.status()).desktop, { count: 2, rssMB: 512 });
  });
  test('lists continued sessions under the server whose key carried them on', async () => {
    const { mgr, key, file } = oneServer();
    sb.writeJson(file('state', 'continued.json'), {
      cse_old: { sessionId: 'cse_new', transcript: 'tr-1', key, at: '2026-10-19T00:00:00Z' },
      cse_new: { sessionId: 'cse_new', transcript: 'tr-1', key, at: '2026-10-19T00:00:00Z' },
    });
    fake.state.processes.push(
      { pid: 800, ppid: 799, cmd: `${CLAUDE} --resume tr-1 --remote-control Old title` },
      { pid: 801, ppid: 1, cmd: `${CLAUDE} --resume tr-unknown --remote-control x` },
    );
    const [s] = (await mgr.status()).servers;
    assert.deepEqual(s.sessions.map((x) => [x.pid, x.sessionId]), [[800, 'cse_new']]);
  });
  test('shows idle hours from the last cleanup pass and which sessions are kept', async (t) => {
    const { mgr, key, folder, cfg, file } = oneServer();
    fake.state.processes.push(server(100, key, { cwd: folder, configDir: cfg }), rcSession(200, 100, 'cse_a'), rcSession(300, 100, 'cse_b'));
    t.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
    const now = 1_000_000_000;
    sb.writeJson(file('state', 'reap.json'), { 200: { idleSince: now - 2.25 * 3600 } });
    mgr.setKeep('cse_a', true);
    mgr.setKeep(300, true);
    const [s] = (await mgr.status()).servers;
    assert.deepEqual(s.sessions.map((x) => [x.pid, x.idleHours, x.kept]), [[200, 2.3, true], [300, null, true]]);
  });
  test('includes the last twelve log lines and the reaper state', async () => {
    const { mgr } = oneServer();
    for (let i = 1; i <= 15; i++) mgr.log(`line ${i}`);
    await mgr.setCleanup(true);
    const st = await mgr.status();
    assert.equal(st.log.length, 12);
    assert.match(st.log.at(-1), /cleanup enabled$/);
    assert.match(st.log[0], /line 5$/);
    assert.equal(st.cleanup.enabled, true);
    assert.equal(st.cleanup.loaded, true);
  });
  test('a server whose cwd cannot be read is listed as unmanaged with no folder', async () => {
    const { mgr } = oneServer();
    fake.state.processes.push(server(150, null));
    const st = await mgr.status();
    assert.deepEqual(st.unmanaged.map((u) => [u.pid, u.cwd]), [[150, null]]);
  });
});

describe('reap()', () => {
  // Process time as ps prints it: [dd-][hh:]mm:ss.cc
  const t = (seconds) => {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = (seconds % 60).toFixed(2).padStart(5, '0');
    return `${d ? `${d}-` : ''}${h || d ? `${String(h).padStart(2, '0')}:` : ''}${String(m).padStart(2, '0')}:${s}`;
  };
  function setup(t0, opts) {
    const m = oneServer(opts);
    t0.mock.timers.enable({ apis: ['Date'], now: 1_000_000_000_000 });
    const kills = [];
    t0.mock.method(process, 'kill', (pid, sig) => { kills.push([pid, sig]); return true; });
    fake.state.processes.push(server(100, m.key, { cwd: m.folder, configDir: m.cfg }));
    return { ...m, kills, now: 1_000_000_000 };
  }

  test('reads ps CPU times in every format into the saved state', async (tt) => {
    const { mgr, file } = setup(tt);
    fake.state.processes.push(
      rcSession(200, 100, 'cse_a', { time: '1:02.50' }),
      rcSession(300, 100, 'cse_b', { time: '2:03:04.00' }),
      rcSession(400, 100, 'cse_c', { time: '3-04:05:06.00' }),
      child(401, 400, { time: '0:10.00' }),
    );
    await mgr.reap();
    const state = sb.readJson(file('state', 'reap.json'));
    assert.equal(state[200].ownCpu, 62.5);
    assert.equal(state[300].ownCpu, 2 * 3600 + 3 * 60 + 4);
    assert.equal(state[400].ownCpu, 3 * 86400 + 4 * 3600 + 5 * 60 + 6);
    assert.equal(state[400].treeCpu, state[400].ownCpu + 10);
  });
  test('the first pass ends nothing and starts every idle clock now', async (tt) => {
    const { mgr, file, kills, now, logText } = setup(tt);
    fake.state.processes.push(rcSession(200, 100, 'cse_a'));
    const r = await mgr.reap();
    assert.deepEqual(r, { checked: 1, ended: [] });
    assert.deepEqual(kills, []);
    assert.equal(sb.readJson(file('state', 'reap.json'))[200].idleSince, now);
    assert.match(logText(), /cleanup checked 1 sessions, ended 0/);
  });
  test('ends a session idle past the limit, killing its whole tree', async (tt) => {
    const { mgr, file, kills, now, logText } = setup(tt);
    fake.state.processes.push(rcSession(200, 100, 'cse_a', { time: t(100), rss: 300 * 1024 }), child(201, 200, { time: t(20) }), rcSession(300, 100, 'cse_b'));
    const lstart = 'Mon Oct 19 09:00:00 2026';
    sb.writeJson(file('state', 'reap.json'), {
      200: { lstart, ownCpu: 99, treeCpu: 119, last: now - 3600, idleSince: now - 4 * 3600 },
      300: { lstart, ownCpu: 0, treeCpu: 0, last: now - 3600, idleSince: now - 3600 },
    });
    const r = await mgr.reap();
    assert.equal(r.checked, 2);
    assert.deepEqual(r.ended, [`rc session cse_a pid=200 idle=4.0h rss=300MB`]);
    assert.deepEqual(kills, [[200, 'SIGKILL'], [201, 'SIGKILL']]);
    const state = sb.readJson(file('state', 'reap.json'));
    assert.ok(!state[200], 'an ended session leaves the state');
    assert.equal(state[300].idleSince, now - 3600, 'a still-idle session keeps its clock');
    assert.match(logText(), /ended rc session cse_a pid=200 idle=4\.0h rss=300MB/);
  });
  test('a dry run reports without killing or saving', async (tt) => {
    const { mgr, file, kills, now } = setup(tt);
    fake.state.processes.push(rcSession(200, 100, 'cse_a'));
    const prev = { 200: { lstart: 'Mon Oct 19 09:00:00 2026', ownCpu: 0, treeCpu: 0, last: now - 3600, idleSince: now - 5 * 3600 } };
    sb.writeJson(file('state', 'reap.json'), prev);
    const r = await mgr.reap({ dryRun: true });
    assert.equal(r.ended.length, 1);
    assert.deepEqual(kills, []);
    assert.deepEqual(sb.readJson(file('state', 'reap.json')), prev);
  });
  test('CPU use above the allowance resets the idle clock', async (tt) => {
    const { mgr, file, kills, now } = setup(tt);
    fake.state.processes.push(rcSession(200, 100, 'cse_a', { time: t(100) }));
    // idleCpuPerHour 30 over one hour allows 30s; 40s of work is activity.
    sb.writeJson(file('state', 'reap.json'), { 200: { lstart: 'Mon Oct 19 09:00:00 2026', ownCpu: 60, treeCpu: 60, last: now - 3600, idleSince: now - 5 * 3600 } });
    await mgr.reap();
    assert.deepEqual(kills, []);
    assert.equal(sb.readJson(file('state', 'reap.json'))[200].idleSince, now);
  });
  test('work in a child process counts as activity', async (tt) => {
    const { mgr, file, kills, now } = setup(tt);
    fake.state.processes.push(rcSession(200, 100, 'cse_a', { time: t(10) }), child(201, 200, { time: t(100) }));
    sb.writeJson(file('state', 'reap.json'), { 200: { lstart: 'Mon Oct 19 09:00:00 2026', ownCpu: 10, treeCpu: 10, last: now - 3600, idleSince: now - 5 * 3600 } });
    await mgr.reap();
    assert.deepEqual(kills, []);
  });
  test('a tree total that fell (a tool process finished) counts as activity', async (tt) => {
    const { mgr, kills, file, now } = setup(tt);
    fake.state.processes.push(rcSession(200, 100, 'cse_a', { time: t(10) }));
    sb.writeJson(file('state', 'reap.json'), { 200: { lstart: 'Mon Oct 19 09:00:00 2026', ownCpu: 10, treeCpu: 500, last: now - 3600, idleSince: now - 5 * 3600 } });
    await mgr.reap();
    assert.deepEqual(kills, []);
  });
  test('a reused pid (different start time) starts a fresh clock', async (tt) => {
    const { mgr, kills, file, now } = setup(tt);
    fake.state.processes.push(rcSession(200, 100, 'cse_a', { lstart: 'Tue Oct 20 10:00:00 2026' }));
    sb.writeJson(file('state', 'reap.json'), { 200: { lstart: 'Mon Oct 19 09:00:00 2026', ownCpu: 0, treeCpu: 0, last: now - 3600, idleSince: now - 5 * 3600 } });
    await mgr.reap();
    assert.deepEqual(kills, []);
    assert.equal(sb.readJson(file('state', 'reap.json'))[200].idleSince, now);
  });
  test('a very short gap still allows two seconds of CPU', async (tt) => {
    const { mgr, kills, file, now } = setup(tt);
    fake.state.processes.push(rcSession(200, 100, 'cse_a', { time: t(11.5) }));
    sb.writeJson(file('state', 'reap.json'), { 200: { lstart: 'Mon Oct 19 09:00:00 2026', ownCpu: 10, treeCpu: 10, last: now - 1, idleSince: now - 5 * 3600 } });
    await mgr.reap();
    assert.equal(kills.length, 1);
  });
  test('kept sessions are never ended, by session id or by pid', async (tt) => {
    const { mgr, kills, file, now } = setup(tt);
    fake.state.processes.push(rcSession(200, 100, 'cse_a'), rcSession(300, 100, 'cse_b'));
    const old = { lstart: 'Mon Oct 19 09:00:00 2026', ownCpu: 0, treeCpu: 0, last: now - 3600, idleSince: now - 9 * 3600 };
    sb.writeJson(file('state', 'reap.json'), { 200: old, 300: old });
    mgr.setKeep('cse_a', true);
    mgr.setKeep(300, true);
    const r = await mgr.reap();
    assert.deepEqual(r.ended, []);
    assert.deepEqual(kills, []);
  });
  test('honours idleHours from profiles.json', async (tt) => {
    const { mgr, kills, file, now } = setup(tt, { extra: { cleanup: { idleHours: 1 } } });
    fake.state.processes.push(rcSession(200, 100, 'cse_a'));
    sb.writeJson(file('state', 'reap.json'), { 200: { lstart: 'Mon Oct 19 09:00:00 2026', ownCpu: 0, treeCpu: 0, last: now - 1800, idleSince: now - 1.5 * 3600 } });
    await mgr.reap();
    assert.equal(kills.length, 1);
  });
  test('desktop app sessions are left alone unless includeDesktop is set', async (tt) => {
    const desktop = [
      { pid: 700, ppid: 1, cmd: '/Applications/Claude.app/Contents/Helpers/disclaimer x' },
      { pid: 701, ppid: 700, cmd: `${CLAUDE} --output-format stream-json` },
    ];
    const a = setup(tt);
    fake.state.processes.push(...desktop);
    assert.equal((await a.mgr.reap()).checked, 1, 'checked counts every session found');
    assert.ok(!sb.readJson(a.file('state', 'reap.json'))[701]);
    fake.reset();
    tt.mock.timers.reset();
    tt.mock.restoreAll();
    const b = setup(tt, { extra: { cleanup: { includeDesktop: true } } });
    fake.state.processes.push(...desktop);
    sb.writeJson(b.file('state', 'reap.json'), { 701: { lstart: 'Mon Oct 19 09:00:00 2026', ownCpu: 0, treeCpu: 0, last: b.now - 3600, idleSince: b.now - 9 * 3600 } });
    const r = await b.mgr.reap();
    assert.deepEqual(r.ended, ['desktop session - pid=701 idle=9.0h rss=1MB']);
  });
  test('trims the log to its last 5000 lines', async (tt) => {
    const { mgr, file } = setup(tt);
    fs.mkdirSync(file('logs'), { recursive: true });
    fs.writeFileSync(file('logs', 'manager.log'), Array.from({ length: 6000 }, (_, i) => `old ${i}`).join('\n') + '\n');
    await mgr.reap();
    const lines = fs.readFileSync(file('logs', 'manager.log'), 'utf8').split('\n');
    assert.equal(lines.length, 5000);
    assert.match(lines.at(-2), /cleanup checked/);
  });
});

describe('endSession() and stopUnmanagedServer()', () => {
  function setup(t0) {
    const m = oneServer();
    const kills = [];
    t0.mock.method(process, 'kill', (pid, sig) => { kills.push([pid, sig]); return true; });
    fake.state.processes.push(server(100, m.key, { cwd: m.folder, configDir: m.cfg }), rcSession(200, 100, 'cse_a', { rss: 128 * 1024 }), child(201, 200), child(202, 201), server(900, null), server(950, 'not-configured'));
    return { ...m, kills };
  }
  test('endSession kills a Remote Control session and everything under it', async (t) => {
    const { mgr, kills, logText } = setup(t);
    await mgr.endSession(200);
    assert.deepEqual(kills, [[200, 'SIGKILL'], [201, 'SIGKILL'], [202, 'SIGKILL']]);
    assert.match(logText(), /ended session cse_a pid=200 by hand, freed 128MB/);
  });
  test('endSession refuses a pid that is not a session', async (t) => {
    const { mgr, kills } = setup(t);
    await assert.rejects(mgr.endSession(100), /pid 100 is not a Remote Control session/);
    await assert.rejects(mgr.endSession(201), /not a Remote Control session/);
    assert.deepEqual(kills, []);
  });
  test('stopUnmanagedServer sends SIGTERM to a hand-started server', async (t) => {
    const { mgr, kills, logText } = setup(t);
    await mgr.stopUnmanagedServer(900);
    await mgr.stopUnmanagedServer(950);
    assert.deepEqual(kills, [[900, 'SIGTERM'], [950, 'SIGTERM']]);
    assert.match(logText(), /stopped unmanaged server pid=900/);
  });
  test('stopUnmanagedServer refuses a managed server or a non-server', async (t) => {
    const { mgr, kills } = setup(t);
    await assert.rejects(mgr.stopUnmanagedServer(100), /that server is managed/);
    await assert.rejects(mgr.stopUnmanagedServer(200), /pid 200 is not a remote-control server/);
    assert.deepEqual(kills, []);
  });
});
