'use strict';
const { sb, fake, makeManager, oneServer, APP_BINARY, HELPER } = require('./helpers/manager-fixture');
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

beforeEach(() => fake.reset());

// RFC 4122 version 5 UUID, written independently of manager.js, to check the transcript names it derives.
function uuidV5(name, namespace) {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = crypto.createHash('sha1').update(Buffer.concat([ns, Buffer.from(name, 'utf8')])).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = b.toString('hex');
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-');
}
const transcriptFor = (cse) => uuidV5(`https://api.anthropic.com/v1/code/sessions/${cse}`, '3ab19d7e-9f35-45c2-926e-75e271cc60b3');
const projectDir = (cfg, folder) => path.join(cfg, 'projects', folder.replace(/[^A-Za-z0-9]/g, '-'));

const stranded = (over = {}) => ({ id: 'session_abc123', environment_kind: 'bridge', connection_status: 'disconnected', environment_id: 'env_dead', title: 'Fix the build', created_at: new Date(Date.now() - 60000).toISOString(), ...over });

// The record the CLI writes once a continuation has opened its claude.ai session.
function recordSession(cfg, transcript, bridgeSessionId, pid = process.pid) {
  sb.writeJson(path.join(cfg, 'sessions', `${pid}.json`), { pid, sessionId: transcript, bridgeSessionId });
}

describe('continueSession(): sessions it leaves alone', () => {
  test('a session that is not Remote Control', async () => {
    const { mgr } = oneServer();
    assert.deepEqual(await mgr.continueSession(['work'], stranded({ environment_kind: 'cloud' })), { skipped: 'not a Remote Control session' });
  });
  test('a connected session', async () => {
    const { mgr } = oneServer();
    assert.deepEqual(await mgr.continueSession(['work'], stranded({ connection_status: 'connected' })), { skipped: 'connected' });
  });
  test('a profile with no usable servers', async () => {
    const { mgr } = oneServer();
    assert.deepEqual(await mgr.continueSession(['other'], stranded()), { skipped: 'this profile has no servers' });
    const { mgr: m2 } = makeManager({ profiles: [{ id: 'x', name: 'X', servers: [{ id: 's', folder: '/tmp' }] }] });
    assert.deepEqual(await m2.continueSession(['x'], stranded()), { skipped: 'this profile has no servers' });
  });
  test('a session still in a running server’s environment', async () => {
    const { mgr, cfg, folder } = oneServer();
    sb.writeJson(path.join(projectDir(cfg, folder), 'bridge-pointer.json'), { environmentId: 'env_live' });
    assert.deepEqual(await mgr.continueSession(['work'], stranded({ environment_id: 'env_live' })), { skipped: 'its server is running' });
  });
  test('a session whose transcript is not on this Mac', async () => {
    const { mgr } = oneServer();
    assert.deepEqual(await mgr.continueSession(['work'], stranded()), { skipped: 'its transcript is not on this Mac' });
    assert.equal(fake.state.spawned.length, 0);
  });
  test('a session already being continued', async () => {
    const { mgr } = oneServer();
    const transcript = transcriptFor('cse_abc123');
    fake.state.processes.push({ pid: 5, ppid: 1, cmd: `/bin/claude --resume ${transcript} --remote-control Fix the build` });
    assert.deepEqual(await mgr.continueSession(['work'], stranded()), { skipped: 'already being continued' });
  });
});

describe('continueSession(): carrying a session on', () => {
  test('finds the transcript by its derived name, starts the helper detached, and returns the new session', async () => {
    const { mgr, cfg, folder, key, configDir, file, logText } = oneServer();
    const transcript = transcriptFor('cse_abc123');
    fs.mkdirSync(projectDir(cfg, folder), { recursive: true });
    fs.writeFileSync(path.join(projectDir(cfg, folder), `${transcript}.jsonl`), '{}\n');
    recordSession(cfg, transcript, 'session_new999');
    const r = await mgr.continueSession(['work'], stranded());
    assert.deepEqual(r, { sessionId: 'cse_new999' });
    const [spawned] = fake.state.spawned;
    assert.equal(spawned.cmd, APP_BINARY);
    assert.deepEqual(spawned.args, [HELPER, 'continue', key, transcript, 'Fix the build']);
    assert.equal(spawned.opts.detached, true);
    assert.equal(spawned.opts.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(spawned.opts.env.CLAUDE_PROFILES_DIR, configDir);
    assert.ok(spawned.child.unrefed);
    const map = sb.readJson(file('state', 'continued.json'));
    assert.equal(map.cse_abc123.sessionId, 'cse_new999');
    assert.equal(map.cse_abc123.transcript, transcript);
    assert.equal(map.cse_abc123.key, key);
    assert.equal(map.cse_new999.sessionId, 'cse_new999');
    assert.match(logText(), /continued session cse_abc123 as cse_new999 under work-app/);
  });
  test('accepts a session_ id or a cse_ id for the same session', async () => {
    const { mgr, cfg, folder } = oneServer();
    const transcript = transcriptFor('cse_abc123');
    fs.mkdirSync(projectDir(cfg, folder), { recursive: true });
    fs.writeFileSync(path.join(projectDir(cfg, folder), `${transcript}.jsonl`), '{}\n');
    recordSession(cfg, transcript, 'cse_new1');
    assert.deepEqual(await mgr.continueSession(['work'], stranded({ id: 'cse_abc123' })), { sessionId: 'cse_new1' });
  });
  test('copies a transcript (and its side folder) from another Claude config into this profile’s', async () => {
    const { mgr, cfg, folder } = oneServer();
    const transcript = transcriptFor('cse_abc123');
    const elsewhere = projectDir(path.join(sb.home, '.claude'), folder);
    fs.mkdirSync(path.join(elsewhere, transcript, 'tool-results'), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, `${transcript}.jsonl`), 'original\n');
    fs.writeFileSync(path.join(elsewhere, transcript, 'tool-results', 'r.txt'), 'side');
    recordSession(cfg, transcript, 'cse_new2');
    assert.deepEqual(await mgr.continueSession(['work'], stranded()), { sessionId: 'cse_new2' });
    const target = projectDir(cfg, folder);
    assert.equal(fs.readFileSync(path.join(target, `${transcript}.jsonl`), 'utf8'), 'original\n');
    assert.equal(fs.readFileSync(path.join(target, transcript, 'tool-results', 'r.txt'), 'utf8'), 'side');
    assert.ok(fs.existsSync(path.join(elsewhere, `${transcript}.jsonl`)), 'the original stays where it was');
  });
  test('marks onboarding done, after backing up .claude.json, so the interactive CLI does not wait on a key', async () => {
    const { mgr, cfg, folder, logText } = oneServer({ cfgExtra: { lastReleaseNotesSeen: '2.1.0', someSetting: 7 } });
    const transcript = transcriptFor('cse_abc123');
    fs.mkdirSync(projectDir(cfg, folder), { recursive: true });
    fs.writeFileSync(path.join(projectDir(cfg, folder), `${transcript}.jsonl`), '{}\n');
    recordSession(cfg, transcript, 'cse_new3');
    const before = fs.readFileSync(path.join(cfg, '.claude.json'), 'utf8');
    await mgr.continueSession(['work'], stranded());
    const j = sb.readJson(path.join(cfg, '.claude.json'));
    assert.equal(j.hasCompletedOnboarding, true);
    assert.equal(j.lastOnboardingVersion, '2.1.0');
    assert.equal(j.someSetting, 7);
    const backups = fs.readdirSync(cfg).filter((n) => n.startsWith('.claude.json.before-onboarding-'));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(cfg, backups[0]), 'utf8'), before);
    assert.match(logText(), /marked Claude Code onboarding done/);
  });
  test('leaves an already-onboarded config untouched', async () => {
    const { mgr, cfg, folder } = oneServer({ cfgExtra: { hasCompletedOnboarding: true } });
    const transcript = transcriptFor('cse_abc123');
    fs.mkdirSync(projectDir(cfg, folder), { recursive: true });
    fs.writeFileSync(path.join(projectDir(cfg, folder), `${transcript}.jsonl`), '{}\n');
    recordSession(cfg, transcript, 'cse_new4');
    await mgr.continueSession(['work'], stranded());
    assert.equal(fs.readdirSync(cfg).filter((n) => n.includes('before-onboarding')).length, 0);
  });
  test('ignores a stale session record whose process has gone', async (t) => {
    const { mgr, cfg, folder } = oneServer();
    const transcript = transcriptFor('cse_abc123');
    fs.mkdirSync(projectDir(cfg, folder), { recursive: true });
    fs.writeFileSync(path.join(projectDir(cfg, folder), `${transcript}.jsonl`), '{}\n');
    recordSession(cfg, transcript, 'cse_stale', 999999);
    recordSession(cfg, transcript, 'cse_live', process.pid);
    const real = process.kill;
    t.mock.method(process, 'kill', (pid, sig) => { if (pid === 999999) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' }); return real.call(process, pid, sig); });
    assert.deepEqual(await mgr.continueSession(['work'], stranded()), { sessionId: 'cse_live' });
  });
  test('opening the stranded original again shows its running continuation without starting another', async () => {
    const { mgr, file } = oneServer();
    sb.writeJson(file('state', 'continued.json'), { cse_abc123: { sessionId: 'cse_cont', transcript: 'tr-1', key: 'work-app' } });
    fake.state.processes.push({ pid: 5, ppid: 1, cmd: '/bin/claude --resume tr-1 --remote-control Fix the build' });
    assert.deepEqual(await mgr.continueSession(['work'], stranded()), { sessionId: 'cse_cont' });
    assert.equal(fake.state.spawned.length, 0);
  });
  test('a continuation that has stopped is resumed again from the same transcript', async () => {
    const { mgr, cfg, folder, file } = oneServer();
    sb.writeJson(file('state', 'continued.json'), { cse_abc123: { sessionId: 'cse_cont', transcript: 'tr-1', key: 'work-app' } });
    fs.mkdirSync(projectDir(cfg, folder), { recursive: true });
    fs.writeFileSync(path.join(projectDir(cfg, folder), 'tr-1.jsonl'), '{}\n');
    recordSession(cfg, 'tr-1', 'cse_cont2');
    assert.deepEqual(await mgr.continueSession(['work'], stranded()), { sessionId: 'cse_cont2' });
    assert.equal(fake.state.spawned[0].args[3], 'tr-1');
  });
  test('gives up after a minute when the continuation never opens a session', async (t) => {
    const { mgr, cfg, folder, file, logText } = oneServer();
    const transcript = transcriptFor('cse_abc123');
    fs.mkdirSync(projectDir(cfg, folder), { recursive: true });
    fs.writeFileSync(path.join(projectDir(cfg, folder), `${transcript}.jsonl`), '{}\n');
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() });
    let result;
    const p = mgr.continueSession(['work'], stranded()).then((r) => { result = r; });
    for (let i = 0; i < 100 && !result; i++) { await sb.flush(); t.mock.timers.tick(1000); }
    await p;
    assert.deepEqual(result, { skipped: 'the continuation did not open a session in time' });
    assert.match(logText(), /no claude\.ai session after 60s, see continued\.err/);
    assert.ok(fs.existsSync(file('logs', 'continued.err')));
    assert.ok(!fs.existsSync(file('state', 'continued.json')));
  });
  test('looks under every profile the caller names, e.g. a profile and the one whose sign-in it shares', async () => {
    const folderA = sb.dir('a');
    const folderB = sb.dir('b');
    const cfgA = sb.claudeConfigDir({ trusted: [folderA] });
    const cfgB = sb.claudeConfigDir({ trusted: [folderB] });
    const { mgr } = makeManager({ profiles: [
      { id: 'a', name: 'A', configDir: cfgA, servers: [{ id: 's', folder: folderA }] },
      { id: 'b', name: 'B', configDir: cfgB, servers: [{ id: 's', folder: folderB }] },
    ] });
    const transcript = transcriptFor('cse_abc123');
    fs.mkdirSync(projectDir(cfgB, folderB), { recursive: true });
    fs.writeFileSync(path.join(projectDir(cfgB, folderB), `${transcript}.jsonl`), '{}\n');
    recordSession(cfgB, transcript, 'cse_b1');
    assert.deepEqual(await mgr.continueSession(['a'], stranded()), { skipped: 'its transcript is not on this Mac' });
    assert.deepEqual(await mgr.continueSession(['a', 'b'], stranded()), { sessionId: 'cse_b1' });
    assert.equal(fake.state.spawned.at(-1).args[2], 'b-s');
  });
});

describe('continueSession(): finding an older transcript by its messages', () => {
  const ids = ['11111111-2222-4333-8444-555555555555', '66666666-7777-4888-8999-aaaaaaaaaaaa'];
  test('greps recent transcripts for the messages’ own uuid field', async () => {
    const { mgr, cfg, folder } = oneServer();
    const dir = projectDir(cfg, folder);
    fs.mkdirSync(dir, { recursive: true });
    const hit = path.join(dir, 'random-name.jsonl');
    fs.writeFileSync(hit, `{"uuid":"${ids[0]}"}\n`);
    fs.writeFileSync(path.join(dir, 'other.jsonl'), '{}\n');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a transcript');
    let grepArgs;
    fake.on('grep', (_c, args) => { grepArgs = args; return `${hit}\n`; });
    recordSession(cfg, 'random-name', 'cse_found');
    const r = await mgr.continueSession(['work'], stranded(), { messageIds: async () => [...ids, 'not-a-uuid', ''] });
    assert.deepEqual(r, { sessionId: 'cse_found' });
    // Malformed ids are dropped; only .jsonl files are searched.
    assert.deepEqual(grepArgs.slice(0, 6), ['-l', '-F', '-e', `"uuid":"${ids[0]}"`, '-e', `"uuid":"${ids[1]}"`]);
    assert.deepEqual(grepArgs.slice(6).sort(), [hit, path.join(dir, 'other.jsonl')].sort());
    assert.equal(fake.state.spawned[0].args[3], 'random-name');
  });
  test('searches only transcripts written since the session started', async () => {
    const { mgr, cfg, folder } = oneServer();
    const dir = projectDir(cfg, folder);
    fs.mkdirSync(dir, { recursive: true });
    const old = path.join(dir, 'old.jsonl');
    fs.writeFileSync(old, '{}\n');
    const past = new Date(Date.now() - 3 * 86400000);
    fs.utimesSync(old, past, past);
    let searched = null;
    fake.on('grep', (_c, args) => { searched = args; return fake.fail('no match', { code: 1 }); });
    const r = await mgr.continueSession(['work'], stranded(), { messageIds: async () => ids });
    assert.deepEqual(r, { skipped: 'its transcript is not on this Mac' });
    assert.equal(searched, null, 'a transcript last written before the session began is not searched');
  });
  test('uses at most eight message ids and survives a failing lookup', async () => {
    const { mgr, cfg, folder } = oneServer();
    fs.mkdirSync(projectDir(cfg, folder), { recursive: true });
    fs.writeFileSync(path.join(projectDir(cfg, folder), 'x.jsonl'), '{}\n');
    let grepArgs;
    fake.on('grep', (_c, args) => { grepArgs = args; return fake.fail('no match', { code: 1 }); });
    const many = Array.from({ length: 12 }, (_, i) => `${String(i).padStart(8, '0')}-0000-4000-8000-000000000000`);
    await mgr.continueSession(['work'], stranded(), { messageIds: async () => many });
    assert.equal(grepArgs.filter((a) => a === '-e').length, 8);
    assert.deepEqual(await mgr.continueSession(['work'], stranded(), { messageIds: async () => { throw new Error('offline'); } }), { skipped: 'its transcript is not on this Mac' });
  });
  test('a transcript found by message that is already being continued is left alone', async () => {
    const { mgr, cfg, folder } = oneServer();
    const dir = projectDir(cfg, folder);
    fs.mkdirSync(dir, { recursive: true });
    const hit = path.join(dir, 'busy.jsonl');
    fs.writeFileSync(hit, '{}\n');
    fake.on('grep', `${hit}\n`);
    fake.state.processes.push({ pid: 5, ppid: 1, cmd: '/bin/claude --resume busy --remote-control t' });
    assert.deepEqual(await mgr.continueSession(['work'], stranded(), { messageIds: async () => ids }), { skipped: 'already being continued' });
  });
});
