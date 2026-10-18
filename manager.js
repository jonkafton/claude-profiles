// Remote Control management for Claude Profiles: launchd jobs that keep one `claude remote-control`
// server per profile+folder running, a cleanup pass that ends idle sessions, and a status snapshot for
// the UI. Shared by the app (main.js) and by the headless helper launchd runs (helper.js), so all of the
// logic ships inside the app. Servers are launchd jobs, so they keep running when the app quits.
'use strict';

const { execFile, execFileSync, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const run = promisify(execFile);
const HOME = os.homedir();
const AGENTS = path.join(HOME, 'Library', 'LaunchAgents');
const DEFAULT_LABEL_PREFIX = 'io.github.jonkafton.claude-profiles';
const LOG_LINES = 5000;
const CLEANUP_DEFAULTS = { idleHours: 3, idleCpuPerHour: 30, includeDesktop: false };
// How long a stopping server gets to shut down cleanly. remote-control gives its sessions 30s to finish.
const SHUTDOWN_GRACE_S = 45;

const { expand, readRaw } = require('./profiles');
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function cpuSeconds(t) { // ps time: [dd-][hh:]mm:ss[.cc]
  let days = 0;
  if (t.includes('-')) { const [d, rest] = t.split('-'); days = Number(d); t = rest; }
  return t.split(':').reduce((acc, part) => acc * 60 + Number(part), 0) + days * 86400;
}

function createManager({ configDir, appBinary, helperPath, labelPrefix }) {
  const stateDir = path.join(configDir, 'state');
  const logsDir = path.join(configDir, 'logs');
  const parkedDir = path.join(stateDir, 'launchd');
  const settingsFile = path.join(stateDir, 'settings.json');
  const reapStateFile = path.join(stateDir, 'reap.json');
  const continuedFile = path.join(stateDir, 'continued.json');
  const logFile = path.join(logsDir, 'manager.log');
  const gui = `gui/${process.getuid()}`;
  // launchd labels; profiles.json may set launchdLabelPrefix, e.g. to keep jobs created under an older name.
  const prefix = () => labelPrefix || process.env.CLAUDE_PROFILES_LABEL_PREFIX || readRaw(configDir).launchdLabelPrefix || DEFAULT_LABEL_PREFIX;
  const serverLabel = (key) => `${prefix()}.server.${key}`;
  const reaperLabel = () => `${prefix()}.reaper`;

  function log(line) {
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(logFile, `${new Date().toISOString().replace('T', ' ').slice(0, 19)} ${line}\n`);
  }
  function trimLog() {
    try {
      const lines = fs.readFileSync(logFile, 'utf8').split('\n');
      if (lines.length > LOG_LINES) fs.writeFileSync(logFile, lines.slice(-LOG_LINES).join('\n'));
    } catch { /* no log yet */ }
  }

  // UI-managed toggles live apart from the hand-edited profiles.json.
  const settings = () => ({ cleanupEnabled: false, keep: [], ...readJson(settingsFile, {}) });
  function saveSettings(patch) {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify({ ...settings(), ...patch }, null, 2));
  }

  function config() {
    const raw = readRaw(configDir);
    // Optional guard rails, e.g. [{ "folderContains": "client-x", "configDir": "~/.claude-client-x" }]:
    // a folder whose path contains the text may only run under that Claude config.
    const pairings = (raw.pairings || []).map((p) => ({ ...p, configDir: expand(p.configDir) }));
    const servers = [];
    for (const p of raw.profiles || []) {
      const cfg = expand(p.configDir);
      for (const s of p.servers || []) {
        const folder = expand(s.folder);
        const server = { key: `${p.id}-${s.id}`, profileId: p.id, profileName: p.name, expectedAccount: p.account || null, folder, configDir: cfg, args: s.args || [], problem: null };
        if (!cfg) server.problem = 'profile has no configDir';
        for (const rule of pairings) {
          if (folder.includes(rule.folderContains) && cfg !== rule.configDir) server.problem = `${rule.folderContains} folders must use ${rule.configDir}`;
        }
        servers.push(server);
      }
    }
    return { raw, servers, cleanup: { ...CLEANUP_DEFAULTS, ...(raw.cleanup || {}) } };
  }

  // What the profile's Claude config says about itself: signed-in account, folder trust, Remote Control consent.
  function claudeConfig(cfgDir, folder) {
    const j = readJson(path.join(cfgDir, '.claude.json'), null);
    if (!j) return { account: null, trusted: false, remoteAccepted: false };
    return {
      account: j.oauthAccount?.emailAddress || null,
      trusted: folder ? !!j.projects?.[folder]?.hasTrustDialogAccepted : true,
      remoteAccepted: !!j.remoteDialogSeen,
    };
  }

  // The environment a folder's server registered, from the pointer the CLI keeps for it.
  const currentEnvironment = (s) => readJson(path.join(s.configDir, 'projects', s.folder.replace(/[^A-Za-z0-9]/g, '-'), 'bridge-pointer.json'), {}).environmentId || null;

  // ---- launchd -----------------------------------------------------------------------------------
  const helperEnv = () => `<key>EnvironmentVariables</key><dict><key>ELECTRON_RUN_AS_NODE</key><string>1</string><key>CLAUDE_PROFILES_DIR</key><string>${xml(configDir)}</string>${process.env.CLAUDE_PROFILES_LABEL_PREFIX ? `<key>CLAUDE_PROFILES_LABEL_PREFIX</key><string>${xml(prefix())}</string>` : ''}</dict>`;
  function plist(label, args, extra) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xml(label)}</string>
  <key>ProgramArguments</key><array>${[appBinary, helperPath, ...args].map((a) => `<string>${xml(a)}</string>`).join('')}</array>
  ${helperEnv()}
  ${extra}
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logsDir, `${label.split('.').pop()}.err`))}</string>
</dict></plist>
`;
  }
  async function loaded(label) {
    try { await run('launchctl', ['print', `${gui}/${label}`]); return true; } catch { return false; }
  }
  // bootout returns before launchd has finished unloading the job; bootstrapping it again before then
  // fails with "5: Input/output error".
  async function unload(label) {
    if (!(await loaded(label))) return;
    await run('launchctl', ['bootout', `${gui}/${label}`]).catch(() => {});
    const deadline = Date.now() + (SHUTDOWN_GRACE_S + 15) * 1000;
    while (Date.now() < deadline && await loaded(label)) await new Promise((r) => setTimeout(r, 250));
  }
  async function bootstrap(label, content) {
    fs.mkdirSync(AGENTS, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
    const file = path.join(AGENTS, `${label}.plist`);
    fs.writeFileSync(file, content);
    await unload(label);
    await run('launchctl', ['bootstrap', gui, file]);
  }
  async function bootout(label) {
    await unload(label);
    const file = path.join(AGENTS, `${label}.plist`);
    // Park the plist rather than delete it, so launchd does not start the job again at login.
    if (fs.existsSync(file)) {
      fs.mkdirSync(parkedDir, { recursive: true });
      fs.renameSync(file, path.join(parkedDir, `${label}.plist`));
    }
  }

  async function startServer(key) {
    const s = config().servers.find((x) => x.key === key);
    if (!s) throw new Error(`no server ${key} in profiles.json`);
    if (s.problem) throw new Error(s.problem);
    const cc = claudeConfig(s.configDir, s.folder);
    if (!cc.trusted) throw new Error(`${s.folder} is not trusted for ${s.configDir}. Run once in Terminal: cd "${s.folder}" && CLAUDE_CONFIG_DIR="${s.configDir}" claude remote-control, answer y, then Ctrl+C.`);
    if (!cc.remoteAccepted) throw new Error(`Remote Control has not been accepted for ${s.configDir}. Run claude remote-control once in Terminal with that CLAUDE_CONFIG_DIR.`);
    await bootstrap(serverLabel(key), plist(serverLabel(key), ['serve', key], `<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>60</integer><key>ExitTimeOut</key><integer>${SHUTDOWN_GRACE_S + 15}</integer>`));
    log(`started server ${key}`);
  }
  // Returns once the server has exited. A restart must not start the next server before then: while the
  // old process is alive, the new one registers a fresh environment, and every session of the old one is
  // stranded on claude.ai ("can't reach this computer"). Once it has exited, the new server takes the old
  // environment back over and its sessions reconnect.
  async function stopServer(key) {
    await bootout(serverLabel(key));
    const deadline = Date.now() + (SHUTDOWN_GRACE_S + 15) * 1000;
    let running = true;
    while (Date.now() < deadline && (running = (await snapshot()).servers.some((s) => s.prefix === key))) await new Promise((r) => setTimeout(r, 500));
    log(running ? `stopped server ${key}, but it had not exited after ${SHUTDOWN_GRACE_S + 15}s` : `stopped server ${key}`);
  }
  async function setCleanup(enabled) {
    saveSettings({ cleanupEnabled: !!enabled });
    if (enabled) await bootstrap(reaperLabel(), plist(reaperLabel(), ['reap'], '<key>StartInterval</key><integer>3600</integer><key>RunAtLoad</key><false/>'));
    else await bootout(reaperLabel());
    log(`cleanup ${enabled ? 'enabled' : 'disabled'}`);
  }

  // ---- the server process itself (run by launchd through helper.js) ----------------------------
  async function loginPath() {
    try {
      const { stdout } = await run('/bin/zsh', ['-lic', 'printf "\\n%s" "$PATH"'], { timeout: 20000 });
      const p = stdout.split('\n').pop().trim();
      if (p) return p;
    } catch { /* fall through */ }
    return [process.env.PATH, `${HOME}/.local/bin`, '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
  }
  function which(cmd, PATH) {
    for (const dir of PATH.split(':')) {
      const f = path.join(dir, cmd);
      try { fs.accessSync(f, fs.constants.X_OK); return f; } catch { /* next */ }
    }
    return null;
  }
  async function serve(key) {
    const s = config().servers.find((x) => x.key === key);
    const args = [...(s?.args || [])];
    if (!args.includes('--remote-control-session-name-prefix')) args.push('--remote-control-session-name-prefix', key);
    await runClaude(`serve ${key}`, s, ['remote-control', ...args]);
  }
  // A stranded session carried on: the interactive CLI resumes its transcript with Remote Control on,
  // which claude.ai shows as a new session holding the whole conversation.
  async function continueRun(key, transcript, title) {
    await runClaude(`continue ${transcript}`, config().servers.find((x) => x.key === key), ['--resume', transcript, '--remote-control', title || 'Continued session']);
  }
  async function runClaude(what, s, argv) {
    if (!s || s.problem) { console.error(`${what}: ${s ? s.problem : 'not in profiles.json'}`); process.exit(78); }
    const PATH = await loginPath();
    const claude = which('claude', PATH);
    if (!claude) { console.error(`${what}: claude not found on PATH`); process.exit(78); }
    const env = { ...process.env, PATH, CLAUDE_CONFIG_DIR: s.configDir };
    for (const k of ['ELECTRON_RUN_AS_NODE', 'CLAUDE_PROFILES_DIR', 'CLAUDE_PROFILES_LABEL_PREFIX']) delete env[k];
    // Markers a Claude Code session sets for its children. Inherited (the app started from inside a
    // session), they make claude stop saving its transcript and recording the claude.ai session it opens.
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
    // claude draws a terminal UI and wants a TTY: script(1) provides a pty. Its stdin must be a
    // real pipe that never closes; Node's own 'pipe' stdio is a socket, which script rejects, so the
    // shell's `tail -f` supplies one.
    const child = spawn('/bin/sh', ['-c', 'tail -f /dev/null | exec /usr/bin/script -q /dev/null "$@"', 'sh', claude, ...argv],
      { cwd: s.folder, env, stdio: ['ignore', 'ignore', 'inherit'] });
    // Stop only the claude process and let it shut down the way Ctrl+C does: a server gives its sessions
    // time to finish and keeps its environment, so the next server reconnects them. Signalling the whole
    // group instead would end every session underneath it at once. launchd (or the app's detached spawn)
    // makes this its own process group; whatever is left of it (sh, tail, script) goes once claude exits.
    let stopping = false;
    const killGroup = (sig) => { try { process.kill(0, sig); } catch { /* gone */ } };
    const stop = () => {
      if (stopping) return;
      stopping = true;
      const server = descendants(child.pid).find(isClaude);
      if (!server) { killGroup('SIGTERM'); process.exit(0); }
      try { process.kill(server.pid, 'SIGTERM'); } catch { /* gone */ }
      setTimeout(() => { killGroup('SIGKILL'); process.exit(1); }, SHUTDOWN_GRACE_S * 1000).unref();
    };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
    // sh waits on tail, which never ends, so the shell outlives claude. Exit once only tail is left, so
    // launchd sees a server that died on its own and starts it again.
    const done = (code) => { killGroup('SIGTERM'); process.exit(code); };
    child.on('exit', (code, signal) => done(code ?? (signal ? 1 : 0)));
    setInterval(() => { if (!descendants(child.pid).some((p) => !/^tail /.test(p.cmd))) done(stopping ? 0 : 1); }, 1000).unref();
  }
  // The processes under the shell that serve() started (sh -> tail, script -> claude -> sessions).
  function descendants(root) {
    let out;
    try { out = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }); } catch { return []; }
    const procs = out.split('\n').map((l) => l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean).map((m) => ({ pid: +m[1], ppid: +m[2], cmd: m[3] }));
    const tree = new Set([root]);
    for (let grew = true; grew;) { grew = false; for (const p of procs) if (tree.has(p.ppid) && !tree.has(p.pid)) { tree.add(p.pid); grew = true; } }
    return procs.filter((p) => p.pid !== root && tree.has(p.pid));
  }
  const isClaude = (p) => path.basename(p.cmd.split(' ')[0]) === 'claude';

  // ---- continuing a stranded session ----------------------------------------------------------
  // A server that restarted before its predecessor had exited registered a new environment, and the old
  // one's sessions show "can't reach this computer" for good: claude.ai refuses a second remote-control
  // for the folder, so they cannot be reattached. Their transcripts are on disk, though, and the
  // interactive CLI can resume one with Remote Control on, beside the folder's server.
  const slug = (folder) => folder.replace(/[^A-Za-z0-9]/g, '-');
  // The CLI names a Remote Control session's transcript with a v5 UUID of its session URL.
  function transcriptOf(cse) {
    const ns = Buffer.from('3ab19d7e9f3545c2926e75e271cc60b3', 'hex');
    const h = require('node:crypto').createHash('sha1').update(ns).update(`https://api.anthropic.com/v1/code/sessions/${cse}`).digest();
    h[6] = (h[6] & 15) | 80; h[8] = (h[8] & 63) | 128;
    const x = h.subarray(0, 16).toString('hex');
    return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
  }
  const cseOf = (id) => String(id).replace(/^session_/, 'cse_');
  // Continuations by stranded session ID and by the ID of the session that carries it on.
  const continued = () => readJson(continuedFile, {});
  function saveContinued(map) { fs.mkdirSync(stateDir, { recursive: true }); fs.writeFileSync(continuedFile, JSON.stringify(map, null, 2)); }
  function continuationRunning(transcript) {
    try { return execFileSync('ps', ['-axo', 'command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').some((c) => isClaude({ cmd: c }) && c.includes(`--resume ${transcript} `)); } catch { return false; }
  }

  // `session` is claude.ai's record of the session being viewed. Returns { sessionId } to show instead,
  // or { skipped } with the reason it was left alone. Waits up to a minute for a new continuation.
  async function continueSession(profileIds, session) {
    const id = cseOf(session.id);
    const skip = (reason) => ({ skipped: reason });
    if (session.environment_kind !== 'bridge') return skip('not a Remote Control session');
    if (session.connection_status === 'connected') return skip('connected');
    const map = continued();
    // Opened the stranded original again: show its continuation while that is still running.
    if (map[id]?.sessionId && map[id].sessionId !== id && continuationRunning(map[id].transcript)) return { sessionId: map[id].sessionId };
    const servers = config().servers.filter((s) => profileIds.includes(s.profileId) && !s.problem);
    if (!servers.length) return skip('this profile has no servers');
    // Still in a running server's environment: that server serves it again on the next message.
    if (session.environment_id && servers.some((s) => currentEnvironment(s) === session.environment_id)) return skip('its server is running');
    // A continuation has no environment of its own; one that stopped is carried on from its transcript.
    if (!session.environment_id && !map[id]) return skip('a terminal session, not one this app continued');
    const transcript = map[id]?.transcript || transcriptOf(id);
    if (continuationRunning(transcript)) return skip('already being continued');
    // The transcript sits under whichever Claude config ran the session; resume it under this profile's.
    const configDirs = [...new Set([...config().servers.map((s) => s.configDir), path.join(HOME, '.claude')])];
    let found = null;
    for (const s of servers) {
      for (const dir of [s.configDir, ...configDirs]) {
        const file = path.join(dir, 'projects', slug(s.folder), `${transcript}.jsonl`);
        if (fs.existsSync(file)) { found = { s, file }; break; }
      }
      if (found) break;
    }
    if (!found) return skip('its transcript is not on this Mac');
    const { s } = found;
    const target = path.join(s.configDir, 'projects', slug(s.folder), `${transcript}.jsonl`);
    if (found.file !== target && !fs.existsSync(target)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(found.file, target);
      const side = found.file.replace(/\.jsonl$/, '');
      if (fs.existsSync(side)) fs.cpSync(side, target.replace(/\.jsonl$/, ''), { recursive: true, force: false });
    }
    // Detached, so it outlives the app the way the launchd servers do.
    fs.mkdirSync(logsDir, { recursive: true });
    const err = fs.openSync(path.join(logsDir, 'continued.err'), 'a');
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', CLAUDE_PROFILES_DIR: configDir };
    if (labelPrefix) env.CLAUDE_PROFILES_LABEL_PREFIX = labelPrefix;
    spawn(appBinary, [helperPath, 'continue', s.key, transcript, session.title || ''], { detached: true, env, stdio: ['ignore', 'ignore', err] }).unref();
    fs.closeSync(err);
    // The CLI records the claude.ai session it opened in <config>/sessions/<pid>.json.
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
      const sessionsDir = path.join(s.configDir, 'sessions');
      let next = null;
      try {
        for (const f of fs.readdirSync(sessionsDir).filter((x) => x.endsWith('.json'))) {
          const rec = readJson(path.join(sessionsDir, f), {});
          if (rec.sessionId === transcript && rec.bridgeSessionId) { try { process.kill(rec.pid, 0); next = cseOf(rec.bridgeSessionId); } catch { /* stale record */ } }
        }
      } catch { /* no sessions folder yet */ }
      if (next) {
        const latest = continued();
        latest[id] = { sessionId: next, transcript, key: s.key, at: new Date().toISOString() };
        latest[next] = { sessionId: next, transcript, key: s.key, at: latest[id].at };
        saveContinued(latest);
        log(`continued session ${id} as ${next} under ${s.key}`);
        return { sessionId: next };
      }
    }
    log(`continuing session ${id} under ${s.key}: no claude.ai session after 60s, see continued.err`);
    return skip('the continuation did not open a session in time');
  }

  // ---- process snapshot ------------------------------------------------------------------------
  async function snapshot() {
    const { stdout } = await run('ps', ['-axo', 'pid=,ppid=,rss=,time=,command='], { maxBuffer: 64 * 1024 * 1024 });
    const procs = new Map();
    const kids = new Map();
    for (const line of stdout.split('\n')) {
      const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
      if (!m) continue;
      const p = { pid: +m[1], ppid: +m[2], rss: +m[3], cpu: cpuSeconds(m[4]), cmd: m[5] };
      procs.set(p.pid, p);
      if (!kids.has(p.ppid)) kids.set(p.ppid, []);
      kids.get(p.ppid).push(p.pid);
    }
    const tree = (pid) => { const out = [pid]; for (let i = 0; i < out.length; i++) out.push(...(kids.get(out[i]) || [])); return out; };
    const argOf = (cmd, flag) => { const m = cmd.match(new RegExp(`${flag}[ =](\\S+)`)); return m ? m[1] : null; };
    const servers = [];
    const sessions = [];
    for (const p of procs.values()) {
      const [argv0, argv1] = p.cmd.split(' ');
      const base = path.basename(argv0);
      if ((base === 'claude' || base === 'claude.exe') && argv1 === 'remote-control') servers.push({ pid: p.pid, prefix: argOf(p.cmd, '--remote-control-session-name-prefix'), cmd: p.cmd });
    }
    const serverPids = new Set(servers.map((s) => s.pid));
    const byTranscript = new Map(Object.values(continued()).map((c) => [c.transcript, c]));
    for (const p of procs.values()) {
      let kind = null;
      if (serverPids.has(p.ppid) && p.cmd.includes('--sdk-url')) kind = 'rc';
      else if (isClaude(p) && / --remote-control( |$)/.test(p.cmd) && argOf(p.cmd, '--resume') && byTranscript.has(argOf(p.cmd, '--resume'))) kind = 'continued';
      else if (procs.get(p.ppid)?.cmd.includes('Claude.app/Contents/Helpers/disclaimer') && p.cmd.includes('--output-format stream-json')) kind = 'desktop';
      if (!kind) continue;
      const pids = tree(p.pid);
      sessions.push({
        kind, pid: p.pid, serverPid: p.ppid, pids,
        sessionId: kind === 'continued' ? byTranscript.get(argOf(p.cmd, '--resume')).sessionId : argOf(p.cmd, '--session-id'),
        key: kind === 'continued' ? byTranscript.get(argOf(p.cmd, '--resume')).key : null,
        ownCpu: p.cpu, treeCpu: pids.reduce((a, x) => a + (procs.get(x)?.cpu || 0), 0), rss: pids.reduce((a, x) => a + (procs.get(x)?.rss || 0), 0),
      });
    }
    return { servers, sessions };
  }
  async function cwdOf(pid) {
    try { const { stdout } = await run('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn']); return (stdout.match(/^n(.*)$/m) || [])[1] || null; } catch { return null; }
  }
  async function configDirOf(pid) {
    try { const { stdout } = await run('ps', ['eww', '-o', 'command=', '-p', String(pid)]); return (stdout.match(/(?:^| )CLAUDE_CONFIG_DIR=(\S+)/) || [])[1] || path.join(HOME, '.claude'); } catch { return null; }
  }
  async function startTimes() {
    const { stdout } = await run('ps', ['-axo', 'pid=,lstart='], { maxBuffer: 16 * 1024 * 1024 });
    const map = new Map();
    for (const line of stdout.split('\n')) { const m = line.match(/^\s*(\d+)\s+(.*)$/); if (m) map.set(+m[1], m[2].trim()); }
    return map;
  }

  async function status() {
    const cfg = config();
    const snap = await snapshot();
    const reap = readJson(reapStateFile, {});
    const now = Date.now() / 1000;
    const keep = new Set(settings().keep);
    const describe = (s) => ({
      pid: s.pid, sessionId: s.sessionId, rssMB: Math.round(s.rss / 1024),
      idleHours: reap[s.pid] ? Math.round(((now - reap[s.pid].idleSince) / 3600) * 10) / 10 : null,
      kept: keep.has(s.sessionId) || keep.has(String(s.pid)),
    });
    const running = await Promise.all(snap.servers.map(async (s) => ({ ...s, cwd: await cwdOf(s.pid), configDir: await configDirOf(s.pid) })));
    const claimed = new Set();
    const servers = [];
    const configuredKeys = new Set(cfg.servers.map((s) => s.key));
    for (const s of cfg.servers) {
      const cc = claudeConfig(s.configDir, s.folder);
      const isLoaded = await loaded(serverLabel(s.key));
      const managed = running.find((r) => r.prefix === s.key);
      // A hand-started server in the same folder under the same profile: shown so it can be retired.
      const terminal = running.filter((r) => !configuredKeys.has(r.prefix) && r.cwd === s.folder && r.configDir === s.configDir);
      if (managed) claimed.add(managed.pid);
      terminal.forEach((t) => claimed.add(t.pid));
      const sess = snap.sessions.filter((x) => (x.kind === 'rc' && managed && x.serverPid === managed.pid) || (x.kind === 'continued' && x.key === s.key));
      servers.push({
        key: s.key, profileId: s.profileId, profileName: s.profileName, expectedAccount: s.expectedAccount, folder: s.folder, configDir: s.configDir,
        problem: s.problem || (!cc.trusted ? 'folder not trusted for this profile' : null),
        account: cc.account, loaded: isLoaded, pid: managed?.pid || null,
        sessions: sess.map(describe), rssMB: Math.round(sess.reduce((a, x) => a + x.rss, 0) / 1024),
        terminal: terminal.map((t) => ({ pid: t.pid, sessions: snap.sessions.filter((x) => x.serverPid === t.pid).map(describe) })),
      });
    }
    const unmanaged = running.filter((r) => !claimed.has(r.pid)).map((r) => ({
      pid: r.pid, cwd: r.cwd, configDir: r.configDir, sessions: snap.sessions.filter((x) => x.serverPid === r.pid).map(describe),
    }));
    const desktop = snap.sessions.filter((x) => x.kind === 'desktop');
    return {
      servers, unmanaged,
      desktop: { count: desktop.length, rssMB: Math.round(desktop.reduce((a, x) => a + x.rss, 0) / 1024) },
      cleanup: { ...cfg.cleanup, enabled: settings().cleanupEnabled, loaded: await loaded(reaperLabel()) },
      log: (() => { try { return fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-12); } catch { return []; } })(),
    };
  }

  // ---- ending sessions --------------------------------------------------------------------------
  function killTree(pids) {
    // SIGKILL on purpose: the server treats the session as crashed and can serve it again on the next message.
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  }
  async function endSession(pid) {
    const s = (await snapshot()).sessions.find((x) => x.pid === pid && (x.kind === 'rc' || x.kind === 'continued'));
    if (!s) throw new Error(`pid ${pid} is not a Remote Control session`);
    killTree(s.pids);
    log(`ended session ${s.sessionId} pid=${pid} by hand, freed ${Math.round(s.rss / 1024)}MB`);
  }
  async function stopUnmanagedServer(pid) {
    const snap = await snapshot();
    const s = snap.servers.find((x) => x.pid === pid);
    if (!s) throw new Error(`pid ${pid} is not a remote-control server`);
    if (s.prefix && config().servers.some((c) => c.key === s.prefix)) throw new Error('that server is managed; stop it from its profile');
    process.kill(pid, 'SIGTERM');
    log(`stopped unmanaged server pid=${pid}`);
  }
  function setKeep(id, on) {
    const keep = new Set(settings().keep);
    if (on) keep.add(String(id)); else keep.delete(String(id));
    saveSettings({ keep: [...keep] });
  }

  // Idle = neither the session nor its live children did real work since the last pass. A tree total
  // that FELL means a tool subprocess finished in between, which is activity, not idleness.
  async function reap({ dryRun = false } = {}) {
    const { idleHours, idleCpuPerHour, includeDesktop } = config().cleanup;
    const keep = new Set(settings().keep);
    const prev = readJson(reapStateFile, {});
    const next = {};
    const now = Date.now() / 1000;
    const starts = await startTimes();
    const { sessions } = await snapshot();
    const ended = [];
    for (const s of sessions) {
      if (s.kind === 'desktop' && !includeDesktop) continue;
      const lstart = starts.get(s.pid);
      if (!lstart) continue;
      const p = prev[s.pid];
      let idleSince = now;
      if (p && p.lstart === lstart) {
        const allowed = Math.max(2, (idleCpuPerHour * (now - p.last)) / 3600);
        const dTree = s.treeCpu - p.treeCpu;
        if (s.ownCpu - p.ownCpu <= allowed && dTree >= 0 && dTree <= allowed) idleSince = p.idleSince;
      }
      const idle = now - idleSince;
      if (idle >= idleHours * 3600 && !keep.has(s.sessionId) && !keep.has(String(s.pid))) {
        const line = `${s.kind} session ${s.sessionId || '-'} pid=${s.pid} idle=${(idle / 3600).toFixed(1)}h rss=${Math.round(s.rss / 1024)}MB`;
        ended.push(line);
        if (!dryRun) { killTree(s.pids); log(`ended ${line}`); }
        continue;
      }
      next[s.pid] = { lstart, ownCpu: s.ownCpu, treeCpu: s.treeCpu, last: now, idleSince };
    }
    if (!dryRun) {
      fs.mkdirSync(stateDir, { recursive: true });
      fs.writeFileSync(reapStateFile, JSON.stringify(next));
      log(`cleanup checked ${sessions.length} sessions, ended ${ended.length}`);
      trimLog();
    }
    return { checked: sessions.length, ended };
  }

  return { log, config, status, startServer, stopServer, setCleanup, serve, continueRun, continueSession, reap, endSession, stopUnmanagedServer, setKeep, claudeConfig };
}

module.exports = { createManager };
