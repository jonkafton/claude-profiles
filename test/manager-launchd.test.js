'use strict';
const { sb, fake, makeManager, oneServer, label, agentsDir, APP_BINARY, HELPER } = require('./helpers/manager-fixture');
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createManager } = require('../manager');

beforeEach(() => fake.reset());

// plutil parses the plist exactly as launchd will; only available on macOS.
const onMac = process.platform === 'darwin';
function parsePlist(file) {
  fake.real.execFileSync('plutil', ['-lint', '-s', file]);
  return JSON.parse(fake.real.execFileSync('plutil', ['-convert', 'json', '-o', '-', file], { encoding: 'utf8' }));
}
const serverProcess = (pid, key) => ({ pid, ppid: 1, cmd: `/Users/x/.local/bin/claude remote-control --remote-control-session-name-prefix ${key}` });

describe('startServer()', () => {
  test('refuses an unknown server', async () => {
    const { mgr } = oneServer();
    await assert.rejects(mgr.startServer('nope'), /no server nope in profiles.json/);
  });
  test('refuses a server with a configuration problem', async () => {
    const { mgr } = makeManager({ profiles: [{ id: 'x', name: 'X', servers: [{ id: 's', folder: '/tmp' }] }] });
    await assert.rejects(mgr.startServer('x-s'), /profile has no configDir/);
  });
  test('refuses an untrusted folder and says how to trust it', async () => {
    const folder = sb.dir('folder');
    const cfg = sb.claudeConfigDir({ trusted: [] });
    const { mgr } = makeManager({ profiles: [{ id: 'w', name: 'W', configDir: cfg, servers: [{ id: 's', folder }] }] });
    await assert.rejects(mgr.startServer('w-s'), (e) => e.message.includes(`${folder} is not trusted for ${cfg}`) && e.message.includes(`cd "${folder}" && CLAUDE_CONFIG_DIR="${cfg}" claude remote-control`));
    assert.equal(fake.state.loaded.size, 0);
  });
  test('refuses when Remote Control has not been accepted', async () => {
    const folder = sb.dir('folder');
    const cfg = sb.claudeConfigDir({ trusted: [folder], remote: false });
    const { mgr } = makeManager({ profiles: [{ id: 'w', name: 'W', configDir: cfg, servers: [{ id: 's', folder }] }] });
    await assert.rejects(mgr.startServer('w-s'), (e) => /Remote Control has not been accepted/.test(e.message)
      && e.message.includes('Press "Set up in Terminal" next to')
      && e.message.includes('"Enable Remote Control?"')
      && e.message.includes('claude remote-control'));
  });
  test('writes a KeepAlive launch agent that runs the helper, and loads it', async () => {
    const { mgr, key, configDir, logText } = oneServer();
    await mgr.startServer(key);
    const file = path.join(agentsDir(), `${label(key)}.plist`);
    assert.ok(fs.existsSync(file));
    assert.ok(fake.state.loaded.has(label(key)));
    const bootstrap = fake.callsTo('launchctl').find((c) => c.args[0] === 'bootstrap');
    assert.deepEqual(bootstrap.args, ['bootstrap', `gui/${process.getuid()}`, file]);
    assert.match(logText(), new RegExp(`started server ${key}`));
    assert.ok(fs.statSync(path.join(configDir, 'logs')).isDirectory());
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /<key>KeepAlive<\/key><true\/>/);
    assert.match(text, /<key>RunAtLoad<\/key><true\/>/);
    assert.match(text, /<key>ThrottleInterval<\/key><integer>60<\/integer>/);
    assert.match(text, /<key>ExitTimeOut<\/key><integer>60<\/integer>/);
  });
  test('the launch agent is a valid plist with the expected program and environment', { skip: !onMac && 'needs plutil' }, async () => {
    const { mgr, key, configDir } = oneServer();
    await mgr.startServer(key);
    const plist = parsePlist(path.join(agentsDir(), `${label(key)}.plist`));
    assert.equal(plist.Label, label(key));
    assert.deepEqual(plist.ProgramArguments, [APP_BINARY, HELPER, 'serve', key]);
    assert.deepEqual(plist.EnvironmentVariables, { ELECTRON_RUN_AS_NODE: '1', CLAUDE_PROFILES_DIR: configDir });
    assert.equal(plist.StandardOutPath, '/dev/null');
    assert.equal(plist.StandardErrorPath, path.join(configDir, 'logs', `${key}.err`));
    assert.equal(plist.KeepAlive, true);
  });
  test('escapes XML in paths', { skip: !onMac && 'needs plutil' }, async () => {
    const folder = sb.dir('folder');
    const cfg = sb.claudeConfigDir({ trusted: [folder] });
    const configDir = path.join(sb.dir(), 'Data & <Things>');
    sb.writeJson(path.join(configDir, 'profiles.json'), { profiles: [{ id: 'w', name: 'W', configDir: cfg, servers: [{ id: 's', folder }] }] });
    const mgr = createManager({ configDir, appBinary: '/A & B/<bin>', helperPath: HELPER });
    await mgr.startServer('w-s');
    const plist = parsePlist(path.join(agentsDir(), `${label('w-s')}.plist`));
    assert.equal(plist.EnvironmentVariables.CLAUDE_PROFILES_DIR, configDir);
    assert.equal(plist.ProgramArguments[0], '/A & B/<bin>');
  });
  test('a server already loaded is unloaded first, waiting until launchd lets it go', async () => {
    const { mgr, key } = oneServer();
    fake.state.loaded.add(label(key));
    fake.state.lingerPrints = 2;
    await mgr.startServer(key);
    const verbs = fake.callsTo('launchctl').map((c) => c.args[0]);
    assert.deepEqual(verbs, ['print', 'bootout', 'print', 'print', 'print', 'bootstrap']);
    assert.ok(fake.state.loaded.has(label(key)));
  });
  test('a failed bootstrap rejects', async () => {
    const { mgr, key } = oneServer();
    fake.on((cmd, args) => cmd === 'launchctl' && args[0] === 'bootstrap', () => fake.fail('Bootstrap failed: 5: Input/output error'));
    await assert.rejects(mgr.startServer(key), /Input\/output error/);
  });
});

describe('launchd label prefix', () => {
  test('defaults to the app id', async () => {
    const { mgr, key } = oneServer();
    await mgr.startServer(key);
    assert.ok(fake.state.loaded.has(`io.github.jonkafton.claude-profiles.server.${key}`));
  });
  test('profiles.json can set launchdLabelPrefix', async () => {
    const { mgr, key } = oneServer({ extra: { launchdLabelPrefix: 'com.example.old' } });
    await mgr.startServer(key);
    assert.ok(fake.state.loaded.has(`com.example.old.server.${key}`));
  });
  test('CLAUDE_PROFILES_LABEL_PREFIX overrides profiles.json and is passed on to the helper', async (t) => {
    process.env.CLAUDE_PROFILES_LABEL_PREFIX = 'test.prefix';
    t.after(() => delete process.env.CLAUDE_PROFILES_LABEL_PREFIX);
    const { mgr, key } = oneServer({ extra: { launchdLabelPrefix: 'com.example.old' } });
    await mgr.startServer(key);
    assert.ok(fake.state.loaded.has(`test.prefix.server.${key}`));
    const text = fs.readFileSync(path.join(agentsDir(), `test.prefix.server.${key}.plist`), 'utf8');
    assert.match(text, /<key>CLAUDE_PROFILES_LABEL_PREFIX<\/key><string>test\.prefix<\/string>/);
  });
  test('the labelPrefix option overrides everything', async (t) => {
    process.env.CLAUDE_PROFILES_LABEL_PREFIX = 'test.prefix';
    t.after(() => delete process.env.CLAUDE_PROFILES_LABEL_PREFIX);
    const { mgr, key } = oneServer({ labelPrefix: 'opt.prefix' });
    await mgr.startServer(key);
    assert.ok(fake.state.loaded.has(`opt.prefix.server.${key}`));
  });
});

describe('stopServer()', () => {
  test('unloads the job and parks its plist so login does not start it again', async () => {
    const { mgr, key, file, logText } = oneServer();
    await mgr.startServer(key);
    await mgr.stopServer(key);
    assert.ok(!fake.state.loaded.has(label(key)));
    assert.ok(!fs.existsSync(path.join(agentsDir(), `${label(key)}.plist`)));
    assert.ok(fs.existsSync(file('state', 'launchd', `${label(key)}.plist`)));
    assert.match(logText(), new RegExp(`stopped server ${key}\\n`));
  });
  test('is harmless for a server that was never started', async () => {
    const { mgr, key, logText } = oneServer();
    await mgr.stopServer(key);
    assert.ok(!fake.callsTo('launchctl').some((c) => c.args[0] === 'bootout'));
    assert.match(logText(), /stopped server/);
  });
  test('returns only once the server process has exited', async () => {
    const { mgr, key } = oneServer();
    fake.state.processes.push(serverProcess(501, key), serverProcess(502, 'some-other-key'));
    let polls = 0;
    fake.on((cmd, args) => cmd === 'ps' && args[1] === 'pid=,ppid=,rss=,time=,command=', () => {
      if (++polls === 3) fake.state.processes.splice(0, 1);
      return fake.state.processes.map((p) => `${p.pid} ${p.ppid} 1000 0:01.00 ${p.cmd}`).join('\n');
    });
    await mgr.stopServer(key);
    assert.equal(polls, 3);
  });
  test('gives up after the grace period and logs that the server had not exited', async (t) => {
    const { mgr, key, logText } = oneServer();
    fake.state.processes.push(serverProcess(501, key));
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let done = false;
    const p = mgr.stopServer(key).then(() => { done = true; });
    for (let i = 0; i < 300 && !done; i++) { await sb.flush(); t.mock.timers.tick(500); }
    await p;
    assert.match(logText(), new RegExp(`stopped server ${key}, but it had not exited after 60s`));
  });
});

describe('setCleanup()', () => {
  test('enabling saves the setting and loads an hourly reaper job', async () => {
    const { mgr, file, logText } = oneServer();
    await mgr.setCleanup(true);
    assert.equal(sb.readJson(file('state', 'settings.json')).cleanupEnabled, true);
    const reaper = 'io.github.jonkafton.claude-profiles.reaper';
    assert.ok(fake.state.loaded.has(reaper));
    const text = fs.readFileSync(path.join(agentsDir(), `${reaper}.plist`), 'utf8');
    assert.match(text, /<string>reap<\/string><\/array>/);
    assert.match(text, /<key>StartInterval<\/key><integer>3600<\/integer><key>RunAtLoad<\/key><false\/>/);
    assert.doesNotMatch(text, /KeepAlive/);
    assert.match(logText(), /cleanup enabled/);
  });
  test('disabling unloads and parks it', async () => {
    const { mgr, file, logText } = oneServer();
    await mgr.setCleanup(true);
    await mgr.setCleanup(false);
    assert.equal(sb.readJson(file('state', 'settings.json')).cleanupEnabled, false);
    assert.equal(fake.state.loaded.size, 0);
    assert.ok(fs.existsSync(file('state', 'launchd', 'io.github.jonkafton.claude-profiles.reaper.plist')));
    assert.match(logText(), /cleanup disabled/);
  });
  test('keeps other settings', async () => {
    const { mgr, file } = oneServer();
    mgr.setKeep('cse_x', true);
    await mgr.setCleanup(true);
    assert.deepEqual(sb.readJson(file('state', 'settings.json')), { cleanupEnabled: true, keep: ['cse_x'] });
  });
});
