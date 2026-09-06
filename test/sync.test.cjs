const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const cp = require('node:child_process');
const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

function load({ home, vault, platform = process.platform, mobile = false, execute } = {}) {
  const notices = [];
  const commands = [];
  class Plugin { addCommand(c) { commands.push(c); } addRibbonIcon() {} }
  class Notice {
    constructor(message) { notices.push(message); }
    setMessage(message) { notices.push(message); }
    hide() {}
  }
  const context = { module: { exports: {} }, process: { platform,
    env: { ...process.env, LOCALAPPDATA: home, XDG_STATE_HOME: home } },
    require(name) {
      if (name === 'obsidian') return { Plugin, Notice, Platform: { isMobile: mobile } };
      if (name === 'node:os') return { homedir: () => home };
      if (name === 'node:child_process' && execute) return { execFile: execute };
      return require(name);
    } };
  vm.runInNewContext(source, context);
  const instance = new context.module.exports();
  instance.app = { vault: { adapter: { getBasePath: () => vault } } };
  return { instance, notices, commands };
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-git-sync-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const config = path.join(dir, 'empty.gitconfig');
  fs.writeFileSync(config, '');
  const git = (cwd, ...args) => cp.execFileSync('git', args, { cwd,
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const remote = path.join(dir, 'remote.git');
  const vault = path.join(dir, 'vault');
  git(dir, 'init', '--bare', '--initial-branch=main', remote);
  git(dir, 'clone', remote, vault);
  git(vault, 'config', 'user.name', 'Test');
  git(vault, 'config', 'user.email', 'test@example.invalid');
  git(vault, 'config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(vault, 'note.md'), 'original\n');
  git(vault, 'add', '.');
  git(vault, 'commit', '-m', 'Initial');
  git(vault, 'push', '-u', 'origin', 'main');
  return { dir, vault, remote, git };
}

test('mobile never registers commands or starts Git', async () => {
  const { instance, commands } = load({ mobile: true });
  instance.onload();
  assert.equal(commands.length, 0);
  assert.equal(await instance.syncVault(), false);
});

test('commits local edits, merges independent remote edits, pushes and verifies', async (t) => {
  const { dir, vault, remote, git } = fixture(t);
  const peer = path.join(dir, 'peer');
  git(dir, 'clone', remote, peer);
  git(peer, 'config', 'user.name', 'Peer');
  git(peer, 'config', 'user.email', 'peer@example.invalid');
  fs.writeFileSync(path.join(peer, 'phone.md'), 'phone edit\n');
  git(peer, 'add', '.'); git(peer, 'commit', '-m', 'Phone'); git(peer, 'push');
  fs.writeFileSync(path.join(vault, 'desktop.md'), 'desktop edit\n');
  const { instance, notices } = load({ home: dir, vault });
  assert.equal(await instance.syncVault(), true, notices.join('\n'));
  assert.equal(git(vault, 'rev-parse', 'HEAD'), git(remote, 'rev-parse', 'main'));
  assert.equal(fs.readFileSync(path.join(vault, 'phone.md'), 'utf8'), 'phone edit\n');
  assert.equal(git(vault, 'status', '--porcelain'), '');
});

test('LFS files upload and can be downloaded by an independent clone', async (t) => {
  const { dir, vault, remote, git } = fixture(t);
  git(vault, 'lfs', 'install', '--local');
  git(vault, 'lfs', 'track', '*.bin');
  const payload = Buffer.alloc(4096, 37);
  fs.writeFileSync(path.join(vault, 'attachment.bin'), payload);
  const { instance, notices } = load({ home: dir, vault });
  assert.equal(await instance.syncVault(), true, notices.join('\n'));
  assert.match(git(vault, 'show', 'HEAD:attachment.bin'), /^version https:\/\/git-lfs/);
  const receiver = path.join(dir, 'receiver');
  git(dir, 'clone', remote, receiver);
  git(receiver, 'lfs', 'install', '--local'); git(receiver, 'lfs', 'pull');
  assert.deepEqual(fs.readFileSync(path.join(receiver, 'attachment.bin')), payload);
});

test('unfinished pull blocks staging and leaves recovery intact', async (t) => {
  const { dir, vault, git } = fixture(t);
  const marker = path.join(vault, '.git', 'MERGE_AUTOSTASH');
  fs.writeFileSync(marker, `${git(vault, 'rev-parse', 'HEAD')}\n`);
  fs.writeFileSync(path.join(vault, 'new.md'), 'unsaved\n');
  const { instance, notices } = load({ home: dir, vault });
  assert.equal(await instance.syncVault(), false);
  assert.ok(notices.some(n => n.includes('unfinished operation')));
  assert.equal(git(vault, 'diff', '--cached', '--name-only'), '');
  assert.ok(fs.existsSync(marker));
});

test('another sync lock is preserved', async (t) => {
  const { dir, vault } = fixture(t);
  const lock = process.platform === 'darwin'
    ? path.join(dir, 'Library', 'Application Support', 'ObsidianVaultSync', 'sync.lock')
    : path.join(dir, 'ObsidianVaultSync', 'sync.lock');
  fs.mkdirSync(lock, { recursive: true });
  const { instance, notices } = load({ home: dir, vault });
  assert.equal(await instance.syncVault(), false);
  assert.ok(notices.some(n => n.includes('Another vault sync')));
  assert.ok(fs.existsSync(lock));
});

test('merge conflict remains unresolved and is never pushed', async (t) => {
  const { dir, vault, remote, git } = fixture(t);
  const peer = path.join(dir, 'peer');
  git(dir, 'clone', remote, peer);
  git(peer, 'config', 'user.name', 'Peer'); git(peer, 'config', 'user.email', 'peer@example.invalid');
  fs.writeFileSync(path.join(peer, 'note.md'), 'phone\n');
  git(peer, 'add', '.'); git(peer, 'commit', '-m', 'Phone'); git(peer, 'push');
  const serverHead = git(remote, 'rev-parse', 'main');
  fs.writeFileSync(path.join(vault, 'note.md'), 'desktop\n');
  const { instance } = load({ home: dir, vault });
  assert.equal(await instance.syncVault(), false);
  assert.equal(git(remote, 'rev-parse', 'main'), serverHead);
  assert.equal(git(vault, 'diff', '--name-only', '--diff-filter=U'), 'note.md');
  assert.equal(await instance.syncVault(), false);
  assert.equal(git(vault, 'diff', '--name-only', '--diff-filter=U'), 'note.md');
});

test('unreachable remote retains local checkpoint and releases the lock', async (t) => {
  const { dir, vault, git } = fixture(t);
  git(vault, 'remote', 'set-url', 'origin', path.join(dir, 'missing.git'));
  fs.writeFileSync(path.join(vault, 'offline.md'), 'preserve this edit\n');
  const { instance, notices } = load({ home: dir, vault });
  assert.equal(await instance.syncVault(), false);
  assert.equal(git(vault, 'show', 'HEAD:offline.md'), 'preserve this edit');
  assert.equal(git(vault, 'status', '--porcelain'), '');
  assert.ok(notices.some(n => n.includes('Getting remote changes stopped')));
  assert.equal(instance.syncing, false);
  assert.equal(await instance.syncVault(), false);
  assert.ok(!notices.some(n => n.includes('Another vault sync')));
});

for (const platform of ['darwin', 'win32', 'linux']) {
  test(`${platform}: correct executable; staging failure stops before networking`, async (t) => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'vault-git-sync-route-'));
    t.after(() => fsp.rm(dir, { recursive: true, force: true }));
    const calls = [];
    const execute = (file, args, options, callback) => {
      calls.push({ file, args, options });
      if (args[0] === 'add') return callback(Object.assign(new Error('stage failed'), { stderr: 'LFS upload filter failed' }));
      const output = args[0] === 'rev-parse' ? dir : args[0] === 'branch' ? 'main' : '';
      callback(null, { stdout: output });
    };
    const { instance, notices } = load({ home: dir, vault: dir, platform, execute });
    assert.equal(await instance.syncVault(), false);
    assert.ok(notices.some(n => n.includes('LFS upload filter failed')));
    assert.ok(calls.some(c => c.args[0] === 'add'));
    assert.ok(!calls.some(c => ['pull', 'push'].includes(c.args[0])));
    assert.ok(calls.every(c => c.file === (platform === 'darwin' ? '/usr/bin/git' : platform === 'win32' ? 'git.exe' : 'git')));
    if (platform === 'darwin') assert.ok(calls[0].options.env.PATH.startsWith('/opt/homebrew/bin:/usr/local/bin:'));
  });
}
