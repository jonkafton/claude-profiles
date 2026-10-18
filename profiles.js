// Reading and writing profiles.json, shared by the app and the headless helper.
// The file stays hand-editable: unknown keys are preserved on save.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HOME = os.homedir();
const DEFAULT_CONFIG_DIR = path.join(HOME, 'Library', 'Application Support', 'Claude Profiles');
const DEFAULT_URL = 'https://claude.ai/code';
// A profile is either Claude Code (web + working folders + Remote Control servers) or Claude Design (web only).
const KINDS = { code: { url: DEFAULT_URL }, design: { url: 'https://claude.ai/design' } };

const expand = (p) => (p && p.startsWith('~') ? path.join(HOME, p.slice(1)) : p);
const tilde = (p) => (p && p.startsWith(HOME + path.sep) ? `~${p.slice(HOME.length)}` : p);

function slug(text, taken = new Set()) {
  const base = String(text).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'profile';
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  return id;
}

function profilesFile(configDir) { return path.join(configDir, 'profiles.json'); }

function readRaw(configDir) {
  const file = profilesFile(configDir);
  if (!fs.existsSync(file)) {
    fs.mkdirSync(configDir, { recursive: true });
    const fresh = {
      comment: 'Managed by Claude Profiles (Profiles screen). You can also edit it by hand; restart the app afterwards. Renaming a profile id signs that profile out.',
      dockIconFollowsProfile: true,
      cleanup: { idleHours: 3, idleCpuPerHour: 30, includeDesktop: false },
      profiles: [],
    };
    fs.writeFileSync(file, JSON.stringify(fresh, null, 2) + '\n');
    return fresh;
  }
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.profiles ||= [];
  return raw;
}

function writeRaw(configDir, raw) {
  const file = profilesFile(configDir);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(raw, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// Create or update one profile from the editor.
// `input` is { id?, kind?, name, account, folders[], icon?, configDir?, url?, shareSignIn? }.
function upsertProfile(configDir, input) {
  const raw = readRaw(configDir);
  const name = String(input.name || '').trim();
  const account = String(input.account || '').trim();
  if (!name) throw new Error('Give the profile a name.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(account)) throw new Error('Enter the email address of the Claude account this profile signs in with.');
  const folders = [...new Set((input.folders || []).map((f) => expand(String(f).trim())).filter(Boolean))];
  for (const f of folders) if (!fs.existsSync(f) || !fs.statSync(f).isDirectory()) throw new Error(`Folder not found: ${f}`);

  let profile = input.id ? raw.profiles.find((p) => p.id === input.id) : null;
  if (input.id && !profile) throw new Error(`No profile "${input.id}".`);
  const kind = input.kind || profile?.kind || 'code';
  if (!KINDS[kind]) throw new Error(`Unknown profile type "${kind}".`);
  const share = input.shareSignIn === undefined ? profile?.shareSignIn : input.shareSignIn || undefined;
  if (share) {
    const target = raw.profiles.find((p) => p.id === share);
    if (!target || target.id === input.id) throw new Error('Choose another existing profile to share a sign-in with.');
    if (target.shareSignIn) throw new Error(`“${target.name}” itself shares another profile’s sign-in; share with that one instead.`);
  }
  if (!profile) {
    profile = { id: slug(name, new Set(raw.profiles.map((p) => p.id))) };
    raw.profiles.push(profile);
  }
  const previousKind = profile.kind || 'code';
  profile.kind = kind;
  profile.name = name;
  profile.account = account;
  profile.shareSignIn = share;
  // A start page that was just the old type's default follows the type.
  const url = input.url?.trim() || profile.url;
  profile.url = url && !(previousKind !== kind && url === KINDS[previousKind].url) ? url : KINDS[kind].url;
  if (input.icon !== undefined) profile.icon = input.icon || undefined;
  if (kind === 'design') {
    // Design is web-only: no Claude Code config, folders or servers.
    delete profile.configDir;
    delete profile.servers;
    writeRaw(configDir, raw);
    return profile;
  }
  profile.configDir = tilde(expand(input.configDir?.trim()) || expand(profile.configDir) || path.join(HOME, `.claude-${profile.id}`));

  // Keep each existing folder's server id and flags; give new folders a fresh id.
  const before = profile.servers || [];
  const used = new Set(before.map((s) => s.id));
  profile.servers = folders.map((folder) => {
    const existing = before.find((s) => expand(s.folder) === folder);
    if (existing) return { ...existing, folder: tilde(folder) };
    const id = slug(path.basename(folder), used);
    used.add(id);
    return { id, folder: tilde(folder) };
  });

  fs.mkdirSync(expand(profile.configDir), { recursive: true });
  writeRaw(configDir, raw);
  return profile;
}

function removeProfile(configDir, id) {
  const raw = readRaw(configDir);
  const dependants = raw.profiles.filter((p) => p.shareSignIn === id).map((p) => p.name);
  if (dependants.length) throw new Error(`${dependants.join(', ')} share${dependants.length === 1 ? 's' : ''} this profile’s sign-in. Change or delete ${dependants.length === 1 ? 'it' : 'them'} first.`);
  const before = raw.profiles.length;
  raw.profiles = raw.profiles.filter((p) => p.id !== id);
  if (raw.profiles.length === before) throw new Error(`No profile "${id}".`);
  writeRaw(configDir, raw);
}

module.exports = { DEFAULT_CONFIG_DIR, DEFAULT_URL, KINDS, expand, tilde, slug, readRaw, writeRaw, upsertProfile, removeProfile };
