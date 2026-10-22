// serve() and continueRun() are what launchd and the app run through helper.js. They call process.exit and
// signal process group 0 (which here would be the test runner's own group), and leave unref'd watchers
// running. So for this whole file process.exit and process.kill only record, and are never restored.
'use strict';
const { sb, fake, makeManager, oneServer } = require('./helpers/manager-fixture');
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const exits = [];
const kills = [];
process.exit = (code) => { exits.push(code); };
process.kill = (pid, sig) => { kills.push([pid, sig]); return true; };
class Exit extends Error {}

// Every spawned shell has a live claude under it (pid + 1), and `tail` beside it, unless a test says otherwise.
// Children from earlier tests stay listed too: their unref'd watchers keep polling, and must keep seeing a
// live claude, or they would record exits in a later test.
const tailOnly = new Set();
const earlier = [];
let claude;
beforeEach(() => {
  earlier.push(...fake.state.spawned);
  fake.reset();
  exits.length = 0;
  kills.length = 0;
  claude = sb.fakeClaudeBin();
  fake.state.loginPath = `${claude.bin}:/usr/bin:/bin`;
  fake.on((cmd, args) => cmd === 'ps' && args[1] === 'pid=,ppid=,command=', () => [...earlier, ...fake.state.spawned].flatMap(({ child }) => [
    `${child.pid + 2} ${child.pid} tail -f /x/feed`,
    ...(tailOnly.has(child.pid) ? [] : [`${child.pid + 1} ${child.pid} /usr/bin/script -q /dev/null ${claude.file} remote-control`, `${child.pid + 3} ${child.pid + 1} ${claude.file} remote-control`]),
  ]).join('\n'));
});

// The SIGTERM handler serve() registers, called directly rather than by signalling the test process.
async function serveAndCatchHandler(mgr, key) {
  const before = new Set(process.listeners('SIGTERM'));
  await mgr.serve(key);
  return process.listeners('SIGTERM').find((l) => !before.has(l));
}

describe('serve()', () => {
  test('exits 78 for a server not in profiles.json, a server with a problem, or a missing claude', async (t) => {
    const errors = [];
    t.mock.method(console, 'error', (m) => errors.push(m));
    const { mgr } = oneServer();
    process.exit = (code) => { exits.push(code); throw new Exit(); };
    try {
      await assert.rejects(mgr.serve('ghost'), Exit);
      const { mgr: m2 } = makeManager({ profiles: [{ id: 'x', name: 'X', servers: [{ id: 's', folder: '/tmp' }] }] });
      await assert.rejects(m2.serve('x-s'), Exit);
      const m3 = oneServer();
      fake.state.loginPath = '/nowhere';
      await assert.rejects(m3.mgr.serve(m3.key), Exit);
    } finally {
      process.exit = (code) => { exits.push(code); };
    }
    assert.deepEqual(exits, [78, 78, 78]);
    assert.deepEqual(errors, ['serve ghost: not in profiles.json', 'serve x-s: profile has no configDir', 'serve work-app: claude not found on PATH']);
    assert.equal(fake.state.spawned.length, 0);
  });
  test('runs `claude remote-control` in a pty in the folder, named after the server key', async () => {
    const { mgr, key, folder, cfg } = oneServer({ args: ['--capacity', '5'] });
    await mgr.serve(key);
    const [s] = fake.state.spawned;
    assert.equal(s.cmd, '/bin/sh');
    assert.deepEqual(s.args, ['-c', 'tail -f "$0" | exec /usr/bin/script -q /dev/null "$@"', '/dev/null', claude.file, 'remote-control', '--capacity', '5', '--remote-control-session-name-prefix', key]);
    assert.equal(s.opts.cwd, folder);
    assert.deepEqual(s.opts.stdio, ['ignore', 'ignore', 'inherit']);
    assert.equal(s.opts.env.CLAUDE_CONFIG_DIR, cfg);
    assert.ok(!('ELECTRON_RUN_AS_NODE' in s.opts.env));
  });
  test('keeps a session name prefix set in profiles.json', async () => {
    const { mgr, key } = oneServer({ args: ['--remote-control-session-name-prefix', 'mine'] });
    await mgr.serve(key);
    assert.deepEqual(fake.state.spawned[0].args.slice(4), ['remote-control', '--remote-control-session-name-prefix', 'mine', '--capacity', '100']);
  });
  test('raises the session limit to 100 unless profiles.json sets one or the server is single-session', async () => {
    const plain = oneServer();
    await plain.mgr.serve(plain.key);
    assert.deepEqual(fake.state.spawned.at(-1).args.slice(4, 7), ['remote-control', '--capacity', '100']);
    const own = oneServer({ args: ['--capacity=8'] });
    await own.mgr.serve(own.key);
    assert.deepEqual(fake.state.spawned.at(-1).args.slice(4, 6), ['remote-control', '--capacity=8']);
    const single = oneServer({ args: ['--spawn', 'session'] });
    await single.mgr.serve(single.key);
    assert.ok(!fake.state.spawned.at(-1).args.includes('--capacity'));
  });
  test('when claude exits, ends the rest of its group and exits with claude’s code', async () => {
    const { mgr, key } = oneServer();
    await mgr.serve(key);
    fake.state.spawned[0].child.emit('exit', 3, null);
    assert.deepEqual(kills, [[0, 'SIGTERM']]);
    assert.deepEqual(exits, [3]);
  });
  test('a claude killed by a signal counts as a failure, so launchd restarts it', async () => {
    const { mgr, key } = oneServer();
    await mgr.serve(key);
    fake.state.spawned[0].child.emit('exit', null, 'SIGKILL');
    assert.deepEqual(exits, [1]);
  });
  test('exits once only tail is left under the shell', async () => {
    const { mgr, key } = oneServer();
    await mgr.serve(key);
    const { child } = fake.state.spawned[0];
    tailOnly.add(child.pid);
    const deadline = Date.now() + 3000;
    while (!exits.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
    tailOnly.delete(child.pid);
    assert.equal(exits[0], 1);
    assert.deepEqual(kills[0], [0, 'SIGTERM']);
  });
  test('on SIGTERM, stops only the claude server and lets it shut down its sessions', async () => {
    const { mgr, key } = oneServer();
    const onTerm = await serveAndCatchHandler(mgr, key);
    const { child } = fake.state.spawned[0];
    onTerm();
    onTerm();
    assert.deepEqual(kills, [[child.pid + 3, 'SIGTERM']], 'the claude process under script, once, not the whole group');
    assert.deepEqual(exits, []);
  });
  test('on SIGTERM with no claude running, ends the group and exits cleanly', async () => {
    const { mgr, key } = oneServer();
    const onTerm = await serveAndCatchHandler(mgr, key);
    const { child } = fake.state.spawned[0];
    tailOnly.add(child.pid);
    onTerm();
    tailOnly.delete(child.pid);
    assert.deepEqual(kills, [[0, 'SIGTERM']]);
    assert.equal(exits[0], 0);
  });
});

describe('continueRun()', () => {
  test('resumes the transcript with Remote Control on, under the session’s title', async () => {
    const { mgr, key, folder, file } = oneServer();
    await mgr.continueRun(key, 'tr-1', 'Fix the build');
    const [s] = fake.state.spawned;
    assert.deepEqual(s.args.slice(3), [claude.file, '--resume', 'tr-1', '--remote-control', 'Fix the build']);
    assert.equal(s.args[2], file('state', 'keys-tr-1'));
    assert.equal(fs.readFileSync(file('state', 'keys-tr-1'), 'utf8'), '');
    assert.equal(s.opts.cwd, folder);
  });
  test('uses a default title', async () => {
    const { mgr, key } = oneServer();
    await mgr.continueRun(key, 'tr-2');
    assert.equal(fake.state.spawned[0].args.at(-1), 'Continued session');
  });
  test('presses Enter through first-run screens until the session is registered', async (t) => {
    const { mgr, key, cfg, file } = oneServer();
    t.mock.timers.enable({ apis: ['setInterval'] });
    await mgr.continueRun(key, 'tr-3', 'T');
    const feed = file('state', 'keys-tr-3');
    const { child } = fake.state.spawned[0];
    t.mock.timers.tick(4000);
    t.mock.timers.tick(4000);
    assert.equal(fs.readFileSync(feed, 'utf8'), '\r\r');
    // The claude under script records the claude.ai session it opened.
    sb.writeJson(path.join(cfg, 'sessions', `${child.pid + 3}.json`), { pid: child.pid + 3, sessionId: 'tr-3', bridgeSessionId: 'session_x' });
    t.mock.timers.tick(4000 * 5);
    assert.equal(fs.readFileSync(feed, 'utf8'), '\r\r');
  });
  test('stops pressing after twelve tries', async (t) => {
    const { mgr, key, file } = oneServer();
    t.mock.timers.enable({ apis: ['setInterval'] });
    await mgr.continueRun(key, 'tr-4', 'T');
    t.mock.timers.tick(4000 * 20);
    assert.equal(fs.readFileSync(file('state', 'keys-tr-4'), 'utf8'), '\r'.repeat(12));
  });
});
