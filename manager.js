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

const { expand, tilde, readRaw } = require('./profiles');
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
  // A login shell takes seconds to start and now and then fails to, so the app keeps the last PATH it
  // got for a few minutes, and falls back to it when a fresh lookup fails.
  let knownPath = null; // { at, value }
  async function loginPath() {
    if (knownPath && Date.now() - knownPath.at < 5 * 60000) return knownPath.value;
    try {
      const { stdout } = await run('/bin/zsh', ['-lic', 'printf "\\n%s" "$PATH"'], { timeout: 20000 });
      const p = stdout.split('\n').pop().trim();
      if (p) { knownPath = { at: Date.now(), value: p }; return p; }
    } catch { /* fall through */ }
    if (knownPath) return knownPath.value;
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
    await runClaude(`continue ${transcript}`, config().servers.find((x) => x.key === key), ['--resume', transcript, '--remote-control', title || 'Continued session'], { answerSetup: transcript });
  }
  // claude from the login shell's PATH, and the environment it runs with under a profile's Claude config.
  async function claudeEnv(cfgDir) {
    const PATH = await loginPath();
    const env = { ...process.env, PATH, CLAUDE_CONFIG_DIR: cfgDir };
    for (const k of ['ELECTRON_RUN_AS_NODE', 'CLAUDE_PROFILES_DIR', 'CLAUDE_PROFILES_LABEL_PREFIX']) delete env[k];
    // Markers a Claude Code session sets for its children. Inherited (the app started from inside a
    // session), they make claude stop saving its transcript and recording the claude.ai session it opens.
    for (const k of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
    return { claude: which('claude', PATH), env };
  }
  async function runClaude(what, s, argv, { answerSetup } = {}) {
    if (!s || s.problem) { console.error(`${what}: ${s ? s.problem : 'not in profiles.json'}`); process.exit(78); }
    const { claude, env } = await claudeEnv(s.configDir);
    if (!claude) { console.error(`${what}: claude not found on PATH`); process.exit(78); }
    // claude draws a terminal UI and wants a TTY: script(1) provides a pty. Its stdin must be a
    // real pipe that never closes; Node's own 'pipe' stdio is a socket, which script rejects, so the
    // shell's `tail -f` supplies one.
    // The interactive CLI can open on first-run screens (theme, welcome, folder trust) that wait for a key.
    // Its input is then a file the helper can type into: tail -f passes on whatever is appended.
    let feed = '/dev/null';
    if (answerSetup) {
      fs.mkdirSync(stateDir, { recursive: true });
      feed = path.join(stateDir, `keys-${answerSetup}`);
      fs.writeFileSync(feed, '');
    }
    const child = spawn('/bin/sh', ['-c', 'tail -f "$0" | exec /usr/bin/script -q /dev/null "$@"', feed, claude, ...argv],
      { cwd: s.folder, env, stdio: ['ignore', 'ignore', 'inherit'] });
    if (answerSetup) {
      // Until claude records the claude.ai session it opened, press Enter now and then: each first-run
      // screen takes its default, as clicking through it would. An empty prompt line does nothing.
      let presses = 0;
      const registered = () => {
        const c = descendants(child.pid).find(isClaude);
        const rec = c && readJson(path.join(s.configDir, 'sessions', `${c.pid}.json`), null);
        return !!rec?.bridgeSessionId;
      };
      const typer = setInterval(() => {
        if (registered() || ++presses > 12) { clearInterval(typer); return; }
        try { fs.appendFileSync(feed, '\r'); } catch { /* gone */ }
      }, 4000);
      typer.unref();
    }
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
  // Older CLIs named a Remote Control session's transcript at random, so it is found by content: a
  // message's own "uuid" field, which claude.ai's event log for the session carries too. Matching the
  // field (not just the ID) skips transcripts that merely mention it.
  // A project folder can hold gigabytes of transcripts, so only files created within a day of the
  // session's start and still written after it are searched.
  async function findByMessage(folders, configDirs, messageIds, startedAt) {
    const start = Date.parse(startedAt) || 0;
    const args = ['-l', '-F', ...messageIds.flatMap((m) => ['-e', `"uuid":"${m}"`])];
    for (const folder of folders) {
      const files = [];
      for (const d of configDirs.map((c) => path.join(c, 'projects', slug(folder)))) {
        let names;
        try { names = fs.readdirSync(d).filter((n) => n.endsWith('.jsonl')); } catch { continue; }
        for (const n of names) {
          try {
            const st = fs.statSync(path.join(d, n));
            if (Math.abs(st.birthtimeMs - start) <= 86400000 && st.mtimeMs >= start) files.push(path.join(d, n));
          } catch { /* gone */ }
        }
      }
      for (let i = 0; i < files.length; i += 200) {
        try {
          const { stdout } = await run('grep', [...args, ...files.slice(i, i + 200)], { maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
          const file = stdout.split('\n').find(Boolean);
          if (file) return { folder, file };
        } catch { /* grep exits 1 when nothing matches */ }
      }
    }
    return null;
  }

  // A continuation runs the interactive CLI, which opens on its first-run screens (theme, welcome) in a
  // Claude config that has only ever run Remote Control, and waits there for a key nobody presses.
  // Mark onboarding done, as clicking through it once would; the file is backed up first.
  function markOnboarded(cfgDir) {
    const file = path.join(cfgDir, '.claude.json');
    const j = readJson(file, null);
    if (!j || j.hasCompletedOnboarding) return;
    fs.copyFileSync(file, `${file}.before-onboarding-${Date.now()}`);
    const latest = readJson(file, j); // re-read just before writing: the CLI rewrites this file too
    latest.hasCompletedOnboarding = true;
    latest.lastOnboardingVersion ||= latest.lastReleaseNotesSeen || '2.0.0';
    fs.writeFileSync(`${file}.tmp-profiles`, JSON.stringify(latest, null, 2));
    fs.renameSync(`${file}.tmp-profiles`, file);
    log(`marked Claude Code onboarding done in ${cfgDir}, so a continued session can start`);
  }

  // `messageIds` (optional) returns IDs of the session's messages, from claude.ai's event log.
  async function continueSession(profileIds, session, { messageIds } = {}) {
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
    let transcript = map[id]?.transcript || transcriptOf(id);
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
    if (!found && messageIds) {
      const ids = (await messageIds().catch(() => [])).filter((m) => /^[0-9a-f-]{36}$/.test(m)).slice(0, 8);
      const hit = ids.length ? await findByMessage([...new Set(servers.map((s) => s.folder))], configDirs, ids, session.created_at) : null;
      if (hit) {
        transcript = path.basename(hit.file, '.jsonl');
        if (continuationRunning(transcript)) return skip('already being continued');
        found = { s: servers.find((s) => s.folder === hit.folder), file: hit.file };
      }
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
    markOnboarded(s.configDir);
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

  // ---- MCP connections ---------------------------------------------------------------------------
  // What a folder's sessions connect to under a profile, as `claude mcp list` reports it: user and local
  // servers from the profile's .claude.json, the folder's .mcp.json, and the account's claude.ai connectors.
  // It health-checks every server (starting the stdio ones), so it runs when asked, not on each status poll.
  const MCP_LOGIN_TIMEOUT_MS = 10 * 60000;
  const DESIGN_LOGIN_TIMEOUT_MS = 6 * 60000;
  const plainText = (s) => s.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '');
  function mcpTarget(key) {
    const s = config().servers.find((x) => x.key === key);
    if (!s) throw new Error(`no server ${key} in profiles.json`);
    if (s.problem) throw new Error(s.problem);
    return s;
  }
  // Lines look like `name: https://host/mcp (HTTP) - ! Needs authentication` or `name: command args - ✔ Connected`.
  function parseMcpList(text) {
    const out = [];
    for (const line of plainText(text).split('\n')) {
      const m = line.match(/^(.+?): (.*) - (.+)$/);
      if (!m) continue;
      const [, name, target, raw] = m;
      const state = /needs auth/i.test(raw) ? 'needs-auth' : /pending approval/i.test(raw) ? 'pending' : /fail/i.test(raw) ? 'failed'
        : /disabled/i.test(raw) ? 'disabled' : /connected/i.test(raw) ? 'connected' : 'other';
      const connector = name.startsWith('claude.ai ');
      out.push({ name, target, state, detail: raw.replace(/^[^\p{L}]+/u, '').trim(), connector, canSignIn: connector || /^https?:\/\//.test(target) });
    }
    return out;
  }
  // Which file configures each server, by name only: the values can hold keys and are never read out.
  // When a name is in several, the CLI uses local over project over user, so it is labelled the same way.
  const MCP_SCOPES = ['local', 'project', 'user'];
  function mcpSources(s) {
    const own = path.join(s.configDir, '.claude.json');
    const shared = path.join(s.folder, '.mcp.json');
    const j = readJson(own, {});
    return {
      files: { local: own, user: own, project: shared },
      names: {
        local: new Set(Object.keys(j.projects?.[s.folder]?.mcpServers || {})),
        project: new Set(Object.keys(readJson(shared, {}).mcpServers || {})),
        user: new Set(Object.keys(j.mcpServers || {})),
      },
    };
  }
  async function mcpList(key) {
    const s = mcpTarget(key);
    const { claude, env } = await claudeEnv(s.configDir);
    if (!claude) throw new Error('claude not found on PATH');
    let stdout;
    try { ({ stdout } = await run(claude, ['mcp', 'list'], { cwd: s.folder, env, timeout: 90000, maxBuffer: 4 * 1024 * 1024 })); }
    catch (e) { if (!e.stdout) throw new Error(`claude mcp list failed: ${(e.stderr || e.message).trim().split('\n').pop()}`); stdout = e.stdout; }
    const { files, names } = mcpSources(s);
    const scopeOf = (c) => (c.connector ? 'claude.ai' : c.name.startsWith('plugin:') ? 'plugin' : MCP_SCOPES.find((x) => names[x].has(c.name)) || 'other');
    return { at: new Date().toISOString(), files, servers: parseMcpList(stdout).map((c) => ({ ...c, scope: scopeOf(c) })) };
  }

  // Adding and removing go through the CLI too (`claude mcp add-json` / `remove`), so the config files are
  // only ever written the way Claude Code writes them. Headers come one per line as `Name: value`,
  // environment variables as `NAME=value`, and a stdio command as one line split the way a shell would.
  function shellWords(line) {
    const words = [];
    let word = null;
    let quote = null;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quote) {
        if (ch === quote) quote = null;
        else if (ch === '\\' && quote === '"' && i + 1 < line.length) word += line[++i];
        else word += ch;
      } else if (ch === '"' || ch === "'") { quote = ch; word ??= ''; }
      else if (ch === '\\' && i + 1 < line.length) word = (word ?? '') + line[++i];
      else if (/\s/.test(ch)) { if (word !== null) words.push(word); word = null; }
      else word = (word ?? '') + ch;
    }
    if (quote) throw new Error('The command has an unclosed quote.');
    if (word !== null) words.push(word);
    return words;
  }
  function pairs(text, sep, what) {
    const out = {};
    for (const line of String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)) {
      const at = line.indexOf(sep);
      if (at < 1) throw new Error(`Each ${what} goes on its own line as ${sep === ':' ? 'Name: value' : 'NAME=value'}: "${line}"`);
      out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    return Object.keys(out).length ? out : undefined;
  }
  async function mcpCli(s, args) {
    const { claude, env } = await claudeEnv(s.configDir);
    if (!claude) throw new Error('claude not found on PATH');
    try {
      const { stdout } = await run(claude, ['mcp', ...args], { cwd: s.folder, env, timeout: 30000 });
      return plainText(stdout).trim();
    } catch (e) {
      throw new Error(plainText(e.stderr || e.stdout || e.message).trim().split('\n').filter(Boolean).pop() || 'claude mcp failed');
    }
  }
  async function mcpAdd(key, input) {
    const s = mcpTarget(key);
    const name = String(input.name || '').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) throw new Error('Use letters, numbers, dots, dashes or underscores for the name.');
    if (!MCP_SCOPES.includes(input.scope)) throw new Error('Choose where to add it.');
    let config;
    if (input.transport === 'http' || input.transport === 'sse') {
      const url = String(input.url || '').trim();
      if (!/^https?:\/\/\S+$/.test(url)) throw new Error('Enter the server URL, starting with https://.');
      config = { type: input.transport, url, headers: pairs(input.headers, ':', 'header') };
    } else if (input.transport === 'stdio') {
      const [command, ...args] = shellWords(String(input.command || '').trim());
      if (!command) throw new Error('Enter the command that starts the server.');
      config = { type: 'stdio', command, args, env: pairs(input.env, '=', 'variable') };
    } else {
      throw new Error('Choose a connection type.');
    }
    const out = await mcpCli(s, ['add-json', '--scope', input.scope, name, JSON.stringify(config)]);
    log(`added MCP server ${name} (${input.scope}) for ${key}`);
    return out;
  }
  async function mcpRemove(key, name, scope) {
    const s = mcpTarget(key);
    if (!MCP_SCOPES.includes(scope)) throw new Error(`${name} is not one this app can remove.`);
    const out = await mcpCli(s, ['remove', String(name), '--scope', scope]);
    log(`removed MCP server ${name} (${scope}) for ${key}`);
    return out;
  }

  // Signs in to one MCP server the way `claude mcp login` does, under the profile's config and in the
  // folder, so a project server resolves. --no-browser makes the CLI print the authorization link rather
  // than open the default browser, so the caller chooses where it opens (onUrl). For an HTTP server the
  // CLI then waits on localhost for the redirect and saves the token; a claude.ai connector's link is
  // finished on claude.ai and the CLI exits at once. Even with the localhost listener the CLI insists on a
  // terminal for its "paste the redirect URL" prompt, so it runs in script(1), fed the way a server is.
  // Returns { done, cancel, url }: done resolves with the CLI's last lines once it has exited.
  async function mcpLogin(key, name, onUrl) {
    const s = mcpTarget(key);
    const { claude, env } = await claudeEnv(s.configDir);
    if (!claude) throw new Error('claude not found on PATH');
    fs.mkdirSync(stateDir, { recursive: true });
    const feed = path.join(stateDir, `keys-mcp-login-${Date.now()}`);
    fs.writeFileSync(feed, '');
    // Its own process group, so cancelling takes sh, tail, script and claude together.
    const child = spawn('/bin/sh', ['-c', 'tail -f "$0" | exec /usr/bin/script -q /dev/null "$@"', feed, claude, 'mcp', 'login', name, '--no-browser'],
      { cwd: s.folder, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let output = '';
    let url = null;
    const collect = (chunk) => {
      output += chunk;
      if (url) return;
      const m = plainText(output).match(/Visit this URL[^\n]*\n\s*(https?:\/\/\S+)/);
      if (m) { url = m[1]; try { onUrl?.(url); } catch (e) { log(`mcp login ${name}: ${e.message}`); } }
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    let finish;
    const done = new Promise((r) => { finish = r; });
    let ended = false;
    const end = (why) => {
      if (ended) return;
      ended = true;
      clearInterval(watch);
      clearTimeout(timer);
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* gone */ }
      try { fs.unlinkSync(feed); } catch { /* gone */ }
      const lines = plainText(output).split('\n').map((l) => l.trim()).filter(Boolean);
      log(`mcp login ${name} under ${key}: ${why}`);
      finish({ url, output: lines.slice(-4).join('\n') });
    };
    // sh waits on tail, which never ends: the CLI is done once only tail is left.
    const watch = setInterval(() => { if (!descendants(child.pid).some((p) => !/^tail /.test(p.cmd))) end('finished'); }, 1000);
    const timer = setTimeout(() => end('timed out'), MCP_LOGIN_TIMEOUT_MS);
    child.on('exit', () => end('finished'));
    log(`mcp login ${name} under ${key}: started`);
    return { done, cancel: () => end('cancelled'), url: () => url };
  }

  // ---- Claude Design access --------------------------------------------------------------------
  // Sessions reach Claude Design projects (/design-sync, design links) with an authorization of their own,
  // which /design-login saves in the config's secure storage. A Remote Control session can't run
  // /design-login, so the app runs the CLI's JSON form of it, made for the VS Code extension. It refuses a
  // terminal on stdin and a parent Claude Code session (claudeEnv drops those markers), never opens a
  // browser itself, and prints JSON lines: { event: 'pages', url } with the approval link, then
  // { event: 'done', ok, message }. Closing its stdin cancels the sign-in.
  async function designStatus(cfgDir) {
    const { claude, env } = await claudeEnv(cfgDir);
    if (!claude) throw new Error('claude not found on PATH');
    const { stdout } = await run(claude, ['design-login', '--json', '--status'], { env, timeout: 30000 });
    const status = JSON.parse(stdout.trim().split('\n').pop() || 'null');
    if (!status || typeof status !== 'object') throw new Error('claude design-login printed no status');
    return status;
  }
  // Returns { done, cancel }: onUrl gets the approval link, done resolves with { ok, message }.
  async function designLogin(cfgDir, onUrl) {
    const { claude, env } = await claudeEnv(cfgDir);
    if (!claude) throw new Error('claude not found on PATH');
    const child = spawn(claude, ['design-login', '--json'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    const who = tilde(cfgDir);
    let lines = '';
    let errors = '';
    let result = null;
    child.stdout.on('data', (chunk) => {
      lines += chunk;
      for (let i = lines.indexOf('\n'); i >= 0; i = lines.indexOf('\n')) {
        const line = lines.slice(0, i).trim();
        lines = lines.slice(i + 1);
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event?.event === 'pages' && typeof event.url === 'string') {
          try { onUrl?.(event.url); } catch (e) { log(`design login for ${who}: ${e.message}`); }
        }
        if (event?.event === 'done') result = { ok: event.ok === true, message: String(event.message || '') };
      }
    });
    child.stderr.on('data', (chunk) => { errors += chunk; });
    let finish;
    const done = new Promise((r) => { finish = r; });
    let ended = false;
    const end = (r) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      log(`design login for ${who}: ${r.ok ? 'authorized' : r.message}`);
      finish(r);
    };
    child.on('error', (e) => end({ ok: false, message: e.message }));
    child.on('close', (code) => end(result || { ok: false, message: errors.trim().split('\n').pop() || `claude design-login exited with ${code}` }));
    // The CLI gives up after five minutes on its own; this only catches one that never exits.
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* gone */ } end({ ok: false, message: 'The sign-in did not finish.' }); }, DESIGN_LOGIN_TIMEOUT_MS);
    log(`design login for ${who}: started`);
    return { done, cancel: () => { try { child.stdin.end(); } catch { /* gone */ } } };
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

  return { log, config, status, startServer, stopServer, setCleanup, serve, continueRun, continueSession, reap, endSession, stopUnmanagedServer, setKeep, claudeConfig, mcpTarget, mcpList, mcpLogin, mcpAdd, mcpRemove, designStatus, designLogin, parseMcpList, shellWords };
}

module.exports = { createManager };
