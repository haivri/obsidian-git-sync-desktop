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
  const tabs = [];
  const buttons = [];
  const modals = [];
  class Element {
    children = []; attributes = {}; textContent = '';
    empty() { this.children = []; }
    addClass() {}
    setAttribute(key, value) { this.attributes[key] = value; }
    createEl(tag, options = {}) { const el = new Element(); el.textContent = options.text || ''; this.children.push(el); return el; }
    createDiv(options) { return this.createEl('div', options); }
  }
  class Modal {
    constructor() { this.contentEl = new Element(); modals.push(this); }
    setTitle() {}
    open() { this.onOpen(); }
    close() { this.onClose(); }
  }
  class PluginSettingTab { constructor() { this.containerEl = new Element(); } }
  class Setting {
    constructor(container) { this.settingEl = container; }
    setName() { return this; } setDesc() { return this; }
    addText(fn) { fn({ setValue() { return this; }, onChange() { return this; } }); return this; }
    addButton(fn) {
      const button = { setButtonText(text) { this.text = text; return this; }, setCta() { return this; },
        onClick(callback) { this.callback = callback; return this; }, setDisabled(disabled) { this.disabled = disabled; return this; } };
      buttons.push(button); fn(button); return this;
    }
  }
  class Plugin { addCommand(c) { commands.push(c); } addRibbonIcon() {} addSettingTab(tab) { tabs.push(tab); } }
  class Notice {
    constructor(message) { notices.push(message); }
    setMessage(message) { notices.push(message); }
    hide() {}
  }
  const context = { module: { exports: {} }, URL, setTimeout, clearTimeout, process: { platform, pid: process.pid, kill: process.kill.bind(process),
    env: { ...process.env, LOCALAPPDATA: home, XDG_STATE_HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home || os.tmpdir(), 'empty.gitconfig') } },
    require(name) {
      if (name === 'obsidian') return { Plugin, Notice, Modal, PluginSettingTab, Setting, Platform: { isMobile: mobile } };
      if (name === 'node:os') return { homedir: () => home };
      if (name === 'node:child_process' && execute) return { execFile: execute };
      return require(name);
    } };
  vm.runInNewContext(source, context);
  const instance = new context.module.exports();
  instance.app = { vault: { adapter: { getBasePath: () => vault } } };
  return { instance, notices, commands, tabs, buttons, modals };
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
      const output = args[0] === 'rev-parse' ? dir : args[0] === 'branch' ? 'main' : args.includes('remote.origin.url') ? 'https://example.invalid/vault.git' : '';
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

function makePeer({ dir, vault, remote, git }) {
  const peer = path.join(dir, 'peer');
  git(dir, 'clone', remote, peer);
  git(peer, 'config', 'user.name', 'Peer'); git(peer, 'config', 'user.email', 'peer@example.invalid');
  return peer;
}

test('manual local commit works without a remote and never uploads', async (t) => {
  const f = fixture(t);
  const server = f.git(f.remote, 'rev-parse', 'main');
  f.git(f.vault, 'remote', 'remove', 'origin');
  fs.writeFileSync(path.join(f.vault, 'offline.md'), 'offline work\n');
  const { instance } = load({ home: f.dir, vault: f.vault });
  assert.equal(await instance.runAction('commit'), true, instance.feedback);
  assert.match(instance.feedback, /Nothing uploaded/);
  assert.equal(f.git(f.vault, 'show', 'HEAD:offline.md'), 'offline work');
  assert.equal(f.git(f.remote, 'rev-parse', 'main'), server);
});

test('manual pull receives server commits without uploading or committing local edits', async (t) => {
  const f = fixture(t); const peer = makePeer(f);
  fs.writeFileSync(path.join(peer, 'server.md'), 'server work\n');
  f.git(peer, 'add', '.'); f.git(peer, 'commit', '-m', 'Server'); f.git(peer, 'push');
  const server = f.git(f.remote, 'rev-parse', 'main');
  const { instance } = load({ home: f.dir, vault: f.vault });
  fs.writeFileSync(path.join(f.vault, 'draft.md'), 'draft\n');
  const before = f.git(f.vault, 'rev-parse', 'HEAD');
  assert.equal(await instance.runAction('pull'), false);
  assert.equal(f.git(f.vault, 'rev-parse', 'HEAD'), before);
  fs.unlinkSync(path.join(f.vault, 'draft.md'));
  assert.equal(await instance.runAction('pull'), true, instance.feedback);
  assert.equal(f.git(f.vault, 'rev-parse', 'HEAD'), server);
  assert.equal(f.git(f.remote, 'rev-parse', 'main'), server);
});

test('manual merge saves both sides locally; push is a separate verified action', async (t) => {
  const f = fixture(t); const peer = makePeer(f);
  fs.writeFileSync(path.join(peer, 'server.md'), 'server work\n');
  f.git(peer, 'add', '.'); f.git(peer, 'commit', '-m', 'Server'); f.git(peer, 'push');
  const server = f.git(f.remote, 'rev-parse', 'main');
  fs.writeFileSync(path.join(f.vault, 'computer.md'), 'computer work\n');
  const { instance } = load({ home: f.dir, vault: f.vault });
  assert.equal(await instance.runAction('merge'), true, instance.feedback);
  assert.equal(f.git(f.remote, 'rev-parse', 'main'), server);
  assert.equal(fs.readFileSync(path.join(f.vault, 'server.md'), 'utf8'), 'server work\n');
  assert.equal(fs.readFileSync(path.join(f.vault, 'computer.md'), 'utf8'), 'computer work\n');
  assert.match(f.git(f.vault, 'for-each-ref', '--format=%(refname)', 'refs/vault-git-sync/checkpoints'), /checkpoints/);
  assert.equal(await instance.runAction('push'), true, instance.feedback);
  assert.equal(f.git(f.remote, 'rev-parse', 'main'), f.git(f.vault, 'rev-parse', 'HEAD'));
});

for (const preference of ['ours', 'theirs']) {
  test(`force merge prefers ${preference}, preserves both histories and checkpoint, never uploads`, async (t) => {
    const f = fixture(t); const peer = makePeer(f);
    fs.writeFileSync(path.join(peer, 'note.md'), 'server choice\n');
    fs.writeFileSync(path.join(peer, 'server-only.md'), 'keep server\n');
    f.git(peer, 'add', '.'); f.git(peer, 'commit', '-m', 'Server'); f.git(peer, 'push');
    const server = f.git(f.remote, 'rev-parse', 'main');
    fs.writeFileSync(path.join(f.vault, 'note.md'), 'computer choice\n');
    fs.writeFileSync(path.join(f.vault, 'computer-only.md'), 'keep computer\n');
    const { instance } = load({ home: f.dir, vault: f.vault });
    assert.equal(await instance.runAction('force', { preference }), true, instance.feedback);
    assert.equal(fs.readFileSync(path.join(f.vault, 'note.md'), 'utf8'), preference === 'ours' ? 'computer choice\n' : 'server choice\n');
    assert.ok(fs.existsSync(path.join(f.vault, 'server-only.md')));
    assert.ok(fs.existsSync(path.join(f.vault, 'computer-only.md')));
    assert.equal(f.git(f.remote, 'rev-parse', 'main'), server);
    f.git(f.vault, 'merge-base', '--is-ancestor', server, 'HEAD');
    const checkpoints = f.git(f.vault, 'for-each-ref', '--format=%(objectname)', 'refs/vault-git-sync/checkpoints').split('\n');
    assert.ok(checkpoints.some(checkpoint => f.git(f.vault, 'show', `${checkpoint}:note.md`) === 'computer choice'));
    assert.ok(checkpoints.includes(server), 'incoming parent stays recoverable');
    assert.equal(await instance.runAction('force', { preference: 'invalid' }), false);
  });
}

test('status recommends merging divergence without altering local files; push refuses newer server work', async (t) => {
  const f = fixture(t); const peer = makePeer(f);
  fs.writeFileSync(path.join(peer, 'server.md'), 'server\n');
  f.git(peer, 'add', '.'); f.git(peer, 'commit', '-m', 'Server'); f.git(peer, 'push');
  fs.writeFileSync(path.join(f.vault, 'computer.md'), 'computer\n');
  const { instance } = load({ home: f.dir, vault: f.vault });
  await instance.runAction('commit');
  const before = f.git(f.vault, 'rev-parse', 'HEAD'); const server = f.git(f.remote, 'rev-parse', 'main');
  assert.equal(await instance.runAction('status'), true, instance.feedback);
  assert.match(instance.feedback, /1 saved commits to upload; 1 server commits to receive/);
  assert.match(instance.feedback, /combine computer and server/);
  assert.equal(await instance.runAction('push'), false);
  assert.equal(await instance.runAction('pull'), false);
  assert.equal(f.git(f.vault, 'rev-parse', 'HEAD'), before);
  assert.equal(f.git(f.remote, 'rev-parse', 'main'), server);
});

test('conflicts require resolution before finish; finishing creates only a local merge', async (t) => {
  const f = fixture(t); const peer = makePeer(f);
  fs.writeFileSync(path.join(peer, 'note.md'), 'server\n');
  f.git(peer, 'add', '.'); f.git(peer, 'commit', '-m', 'Server'); f.git(peer, 'push');
  const server = f.git(f.remote, 'rev-parse', 'main');
  fs.writeFileSync(path.join(f.vault, 'note.md'), 'computer\n');
  const { instance } = load({ home: f.dir, vault: f.vault });
  assert.equal(await instance.runAction('merge'), false);
  assert.equal(await instance.runAction('finish'), false);
  fs.writeFileSync(path.join(f.vault, 'note.md'), 'reviewed combined text\n');
  f.git(f.vault, 'add', 'note.md');
  assert.equal(await instance.runAction('finish'), true, instance.feedback);
  assert.equal(f.git(f.vault, 'status', '--porcelain'), '');
  assert.equal(f.git(f.remote, 'rev-parse', 'main'), server);
});

test('manual settings wire every action, show persistent feedback, and confirm force preferences', async () => {
  const { instance, tabs, buttons, modals } = load();
  instance.onload();
  tabs[0].display();
  const calls = [];
  instance.runAction = async (...args) => { calls.push(args); return true; };
  for (const [label, action] of [['Commit locally', 'commit'], ['Pull', 'pull'], ['Merge', 'merge'], ['Push', 'push'], ['Check status', 'status'], ['Finish merge', 'finish'], ['Sync now', 'sync']]) {
    await buttons.find(button => button.text === label).callback();
    assert.equal(calls.at(-1)[0], action);
  }
  const count = calls.length;
  buttons.find(button => button.text === 'Choose preference…').callback();
  assert.equal(calls.length, count, 'opening confirmation cannot merge');
  buttons.find(button => button.text === 'Merge — prefer server').callback();
  assert.equal(calls.at(-1)[0], 'force');
  assert.equal(calls.at(-1)[1].preference, 'theirs');
  instance.syncing = true;
  instance.report('Uploading changes…');
  assert.ok(buttons.slice(0, 8).every(button => button.disabled));
  assert.ok(tabs[0].containerEl.children.some(el => el.textContent === 'Uploading changes…'));
  tabs[0].hide();
  assert.equal(instance.listeners.size, 0);
  assert.equal(modals.length, 1);
});

function freshVault(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-setup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const vault = path.join(dir, 'vault'); fs.mkdirSync(vault);
  const config = path.join(dir, 'empty.gitconfig'); fs.writeFileSync(config, '');
  const git = (cwd, ...args) => cp.execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: config } }).trim();
  const remote = path.join(dir, 'remote.git'); git(dir, 'init', '--bare', '--initial-branch=main', remote);
  // HTTPS-shaped input exercises validation without contacting a real host.
  const url = 'https://setup.example.invalid/vault.git';
  git(dir, 'config', '--file', config, `url.${remote}.insteadOf`, url);
  fs.writeFileSync(path.join(vault, 'note.md'), 'Whole vault\n');
  const loaded = load({ home: dir, vault });
  const prepare = () => loaded.instance.runAction('prepare', { name: 'Setup Test', email: 'setup@example.invalid' });
  const upload = () => loaded.instance.runAction('upload', { expectedRemote: url, expectedBranch: 'main' });
  return { dir, vault, remote, url, git, ...loaded, prepare, upload };
}

test('fresh setup includes arbitrary files, hidden settings and case-insensitive LFS attachments; retries are stable', async t => {
  const f = freshVault(t);
  for (const name of ['image.PnG', 'photo.JPEG', 'document.pdf', 'custom.xyz', '.hidden', '.obsidian/plugins/demo/main.js', '.obsidian/plugins/demo/data.json', '.obsidian/themes/demo/theme.css', '.obsidian/workspace.json', '.trash/deleted.md', '.obsidian/cache/item']) {
    const file = path.join(f.vault, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `payload ${name}\n`);
  }
  fs.writeFileSync(path.join(f.vault, '.gitignore'), 'private.txt\n'); fs.writeFileSync(path.join(f.vault, 'private.txt'), 'ignored');
  fs.writeFileSync(path.join(f.vault, '.gitattributes'), '*.md text\n');
  assert.equal(await f.prepare(), true, f.instance.feedback);
  const tracked = f.git(f.vault, 'ls-files');
  for (const file of ['custom.xyz', '.hidden', '.obsidian/plugins/demo/data.json', '.obsidian/themes/demo/theme.css']) assert.ok(tracked.includes(file), file);
  for (const file of ['private.txt', 'workspace.json', '.trash/', '.obsidian/cache/']) assert.ok(!tracked.includes(file), file);
  for (const file of ['image.PnG', 'photo.JPEG', 'document.pdf']) assert.match(f.git(f.vault, 'show', `HEAD:${file}`), /^version https:\/\/git-lfs/);
  assert.match(f.git(f.vault, 'show', 'HEAD:custom.xyz'), /payload/);
  assert.match(fs.readFileSync(path.join(f.vault, '.gitattributes'), 'utf8'), /^\*\.md text\r?\n/);
  const attributes = fs.readFileSync(path.join(f.vault, '.gitattributes'), 'utf8');
  assert.ok(attributes.includes('*.PnG filter=lfs'));
  assert.ok(!attributes.includes('['), 'patterns remain compatible with VaultBridge wildcard matching');
  const head = f.git(f.vault, 'rev-parse', 'HEAD');
  assert.equal(await f.prepare(), true);
  assert.equal(f.git(f.vault, 'rev-parse', 'HEAD'), head);
  assert.equal(f.git(f.vault, 'status', '--porcelain'), '');
  assert.equal(f.git(f.vault, 'config', '--local', 'filter.lfs.required'), 'true');
});

test('connect and first upload round-trip attachments and establish normal two-way sync', async t => {
  const f = freshVault(t);
  const payload = Buffer.alloc(8192, 41); fs.writeFileSync(path.join(f.vault, 'photo.png'), payload);
  assert.equal(await f.prepare(), true, f.instance.feedback);
  assert.equal(await f.instance.runAction('status'), true);
  assert.match(f.instance.feedback, /computer only/);
  assert.equal(await f.instance.runAction('connect', { url: f.url }), true, f.instance.feedback);
  assert.equal(await f.instance.runAction('push'), true);
  assert.match(f.instance.feedback, /remote is empty/);
  assert.equal(await f.upload(), true, f.instance.feedback);
  assert.equal(f.git(f.remote, 'rev-parse', 'main'), f.git(f.vault, 'rev-parse', 'HEAD'));
  assert.equal(f.git(f.vault, 'config', 'branch.main.remote'), 'origin');
  const peer = path.join(f.dir, 'peer'); f.git(f.dir, 'clone', f.remote, peer); f.git(peer, 'lfs', 'install', '--local'); f.git(peer, 'lfs', 'pull');
  assert.ok(fs.readFileSync(path.join(peer, 'photo.png')).equals(payload), 'independent clone receives attachment bytes');
  f.git(peer, 'config', 'user.name', 'Peer'); f.git(peer, 'config', 'user.email', 'peer@example.invalid');
  fs.writeFileSync(path.join(peer, 'peer.md'), 'remote'); f.git(peer, 'add', '.'); f.git(peer, 'commit', '-m', 'Peer'); f.git(peer, 'push');
  fs.writeFileSync(path.join(f.vault, 'local.md'), 'local');
  assert.equal(await f.instance.syncVault(), true, f.instance.feedback);
  assert.equal(fs.readFileSync(path.join(f.vault, 'peer.md'), 'utf8'), 'remote');
});

test('missing identity and missing LFS stop before repository creation', async t => {
  const f = freshVault(t);
  assert.equal(await f.instance.runAction('prepare'), false);
  assert.match(f.instance.feedback, /name and email/);
  assert.equal(fs.existsSync(path.join(f.vault, '.git')), false);
  const execute = (file, args, opts, cb) => {
    if (args[0] === 'lfs') return cb(new Error('missing LFS'));
    cp.execFile(file, args, opts, (error, stdout, stderr) => { if (error) error.stderr = stderr; cb(error, { stdout }); });
  };
  const missing = load({ home: f.dir, vault: f.vault, execute });
  assert.equal(await missing.instance.runAction('prepare', { name: 'Test', email: 'test@example.invalid' }), false);
  assert.match(missing.instance.feedback, /Install Git LFS/);
  assert.equal(fs.existsSync(path.join(f.vault, '.git')), false);
});

test('setup refuses parent repositories and broken metadata', async t => {
  const f = freshVault(t); f.git(f.dir, 'init');
  assert.equal(await f.prepare(), false); assert.match(f.instance.feedback, /parent repository/);
  assert.equal(fs.existsSync(path.join(f.vault, '.git')), false);
  fs.writeFileSync(path.join(f.vault, '.git'), 'broken metadata');
  assert.equal(await f.prepare(), false);
  assert.equal(fs.readFileSync(path.join(f.vault, '.git'), 'utf8'), 'broken metadata');
});

test('remote validation, explicit replacement and destination review prevent unintended uploads', async t => {
  const f = freshVault(t); await f.prepare();
  for (const url of ['https://user:secret@example.invalid/vault', 'https://example.invalid/vault?token=secret', '--upload-pack=bad', 'file:///tmp/remote', 'http://example.invalid/vault']) {
    assert.equal(await f.instance.runAction('connect', { url }), false);
    assert.ok(!f.instance.feedback.includes('secret'));
  }
  assert.equal(await f.instance.runAction('connect', { url: f.url }), true);
  assert.equal(await f.instance.runAction('connect', { url: 'https://elsewhere.example.invalid/vault' }), false);
  assert.match(f.instance.feedback, /Replace remote/);
  assert.equal(await f.instance.runAction('upload', { expectedRemote: 'wrong', expectedBranch: 'main' }), false);
  assert.equal(f.git(f.remote, 'for-each-ref'), '');
});

test('unrelated and newly populated remotes are preserved', async t => {
  const f = freshVault(t); await f.prepare();
  assert.equal(await f.instance.runAction('connect', { url: f.url }), true);
  const peer = path.join(f.dir, 'peer'); f.git(f.dir, 'clone', f.remote, peer);
  f.git(peer, 'config', 'user.name', 'Peer'); f.git(peer, 'config', 'user.email', 'peer@example.invalid');
  fs.writeFileSync(path.join(peer, 'other.md'), 'unrelated'); f.git(peer, 'add', '.'); f.git(peer, 'commit', '-m', 'Different history'); f.git(peer, 'push');
  const server = f.git(f.remote, 'rev-parse', 'main');
  assert.equal(await f.upload(), false); assert.match(f.instance.feedback, /contains history/);
  assert.equal(await f.instance.runAction('connect', { url: f.url }), false); assert.match(f.instance.feedback, /unrelated history/);
  assert.equal(f.git(f.remote, 'rev-parse', 'main'), server);
});

test('setup retains custom hooks on failure and resumes after repair', async t => {
  const f = freshVault(t);
  f.git(f.vault, 'init', '--initial-branch=main'); f.git(f.vault, 'config', 'gitSyncDesktop.setupPending', 'true');
  const hook = path.join(f.vault, '.git/hooks/pre-push'); fs.writeFileSync(hook, '#!/bin/sh\necho custom\n');
  assert.equal(await f.prepare(), false); assert.match(fs.readFileSync(hook, 'utf8'), /custom/);
  fs.renameSync(hook, hook + '.preserved');
  assert.equal(await f.prepare(), true, f.instance.feedback);
  assert.match(fs.readFileSync(hook + '.preserved', 'utf8'), /custom/);
});

test('setup modal registers, previews whole vault coverage and cleans listeners on close', async t => {
  const f = freshVault(t); f.instance.onload();
  f.commands.find(c => c.id === 'setup-vault-sync').callback();
  const modal = f.modals[0]; clearTimeout(modal.timer); await modal.check();
  assert.ok(f.buttons.some(b => b.text === 'Set up this vault'));
  assert.ok(f.buttons.some(b => b.text === 'Review upload'));
  const texts = el => el.textContent + el.children.map(texts).join(' ');
  assert.match(texts(modal.contentEl), /every attachment type/);
  modal.close(); assert.equal(f.instance.listeners.size, 0);
});

test('separate push destinations remain unchanged and block setup uploads', async t => {
  const f = freshVault(t); await f.prepare();
  await f.instance.runAction('connect', { url: f.url });
  f.git(f.vault, 'config', 'remote.origin.pushurl', 'https://different.example.invalid/vault.git');
  assert.equal(await f.upload(), false); assert.match(f.instance.feedback, /separate push destination/);
  assert.equal(await f.instance.runAction('connect', { url: f.url, replace: true }), false);
  assert.equal(f.git(f.vault, 'config', 'remote.origin.pushurl'), 'https://different.example.invalid/vault.git');
  assert.equal(f.git(f.remote, 'for-each-ref'), '');
});

test('existing repositories preserve author identity, rules and history during preparation', async t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.vault, '.gitattributes'), '*.pdf -filter\n');
  const head = f.git(f.vault, 'rev-parse', 'HEAD');
  const { instance } = load({ home: f.dir, vault: f.vault });
  assert.equal(await instance.runAction('prepare', { name: 'Different', email: 'different@example.invalid' }), true);
  assert.equal(f.git(f.vault, 'config', 'user.name'), 'Test');
  assert.equal(f.git(f.vault, 'rev-parse', 'HEAD'), head);
  assert.equal(fs.readFileSync(path.join(f.vault, '.gitattributes'), 'utf8'), '*.pdf -filter\n');
  assert.equal(fs.existsSync(path.join(f.vault, '.gitignore')), false);
});

test('guided settings choice preserves incoming notes through finish and a second sync', async t => {
  const f = fixture(t); const peer = makePeer(f);
  fs.writeFileSync(path.join(peer, 'note.md'), 'server\n');
  fs.writeFileSync(path.join(peer, 'today.md'), 'journal entry\n');
  f.git(peer, 'add', '.'); f.git(peer, 'commit', '-m', 'Server'); f.git(peer, 'push');
  fs.writeFileSync(path.join(f.vault, 'note.md'), 'phone\n');
  const { instance } = load({ home: f.dir, vault: f.vault });
  assert.equal(await instance.syncVault(), false);
  assert.equal(instance.attention.kind, 'conflicts');
  assert.equal(await instance.runAction('review'), true);
  const entry = instance.review[0];
  assert.equal(await instance.runAction('resolve', { path: entry.path, fingerprint: entry.fingerprint, choice: 'server' }), true, instance.feedback);
  assert.equal(await instance.syncVault(), true, instance.feedback);
  assert.equal(fs.readFileSync(path.join(f.vault, 'today.md'), 'utf8'), 'journal entry\n');
  assert.equal(await instance.syncVault(), true, instance.feedback);
  assert.equal(f.git(f.remote, 'show', 'main:today.md'), 'journal entry');
  assert.equal(instance.outcome.kind, 'complete');
});

test('review refuses a stale choice when an editor changes a conflicting file', async t => {
  const f = fixture(t); const peer = makePeer(f);
  fs.writeFileSync(path.join(peer, 'note.md'), 'server\n'); f.git(peer, 'add', '.'); f.git(peer, 'commit', '-m', 'Server'); f.git(peer, 'push');
  fs.writeFileSync(path.join(f.vault, 'note.md'), 'phone\n');
  const { instance } = load({ home: f.dir, vault: f.vault });
  await instance.syncVault(); await instance.runAction('review'); const entry = instance.review[0];
  fs.writeFileSync(path.join(f.vault, 'note.md'), 'new work while reviewing\n');
  assert.equal(await instance.runAction('resolve', { path: entry.path, fingerprint: entry.fingerprint, choice: 'server' }), false);
  assert.equal(fs.readFileSync(path.join(f.vault, 'note.md'), 'utf8'), 'new work while reviewing\n');
});

test('unexpected loss of a received note is blocked and restored', async t => {
  const f = fixture(t); const peer = makePeer(f);
  fs.writeFileSync(path.join(peer, 'today.md'), 'keep me\n'); f.git(peer, 'add', '.'); f.git(peer, 'commit', '-m', 'Server'); f.git(peer, 'push');
  const { instance } = load({ home: f.dir, vault: f.vault });
  assert.equal(await instance.syncVault(), true, instance.feedback);
  assert.equal(await instance.syncVault(), true, 'A no-op sync must retain incoming protection');
  fs.unlinkSync(path.join(f.vault, 'today.md'));
  assert.equal(await instance.syncVault(), false);
  assert.equal(instance.attention.kind, 'deletions');
  assert.equal(f.git(f.remote, 'show', 'main:today.md'), 'keep me');
  assert.equal(await instance.runAction('recover'), true, instance.feedback);
  assert.equal(await instance.syncVault(), true, instance.feedback);
  assert.equal(fs.readFileSync(path.join(f.vault, 'today.md'), 'utf8'), 'keep me\n');
  fs.unlinkSync(path.join(f.vault, 'today.md'));
  assert.equal(await instance.syncVault(), false);
  assert.equal(await instance.runAction('approve-deletions', { fingerprint: instance.attention.fingerprint }), true);
  assert.equal(await instance.syncVault(), true, instance.feedback);
  assert.equal(await instance.syncVault(), true, 'An explicitly approved deletion must not ask again');
});

test('large deletion review authorizes only the reviewed changes', async t => {
  const f = fixture(t);
  for (let n = 0; n < 6; n++) fs.writeFileSync(path.join(f.vault, `note-${n}.md`), 'saved\n');
  const { instance } = load({ home: f.dir, vault: f.vault }); await instance.syncVault();
  for (let n = 0; n < 5; n++) fs.unlinkSync(path.join(f.vault, `note-${n}.md`));
  assert.equal(await instance.syncVault(), false);
  const review = instance.attention;
  fs.unlinkSync(path.join(f.vault, 'note-5.md'));
  assert.equal(await instance.runAction('approve-deletions', { fingerprint: review.fingerprint }), false);
  await instance.syncVault();
  assert.equal(await instance.runAction('approve-deletions', { fingerprint: instance.attention.fingerprint }), true);
  assert.equal(await instance.syncVault(), true, instance.feedback);
});

test('command-line helper uses the same runtime without Obsidian', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.vault, 'helper.md'), 'background\n');
  const result = cp.spawnSync(process.execPath, [path.join(__dirname, '..', 'main.js'), '--sync', f.vault], {
    env: { ...process.env, HOME: f.dir, XDG_STATE_HOME: f.dir, LOCALAPPDATA: f.dir }, encoding: 'utf8'
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  assert.equal(f.git(f.remote, 'show', 'main:helper.md'), 'background');
  assert.equal(JSON.parse(result.stdout).kind, 'complete');
});

test('an abandoned owner lock is recovered but a live Git child is never displaced', async t => {
  const f = fixture(t);
  const state = process.platform === 'darwin' ? path.join(f.dir, 'Library', 'Application Support', 'ObsidianVaultSync') : path.join(f.dir, 'ObsidianVaultSync');
  const lock = path.join(state, 'sync.lock'); fs.mkdirSync(lock, { recursive: true });
  // A process that has exited gives a real, provably inactive PID.
  const exited = cp.spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: exited.pid, childPID: process.pid }));
  const { instance } = load({ home: f.dir, vault: f.vault });
  assert.equal(await instance.syncVault(), false);
  assert.ok(fs.existsSync(lock));
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: exited.pid }));
  assert.equal(await instance.syncVault(), true, instance.feedback);
  assert.equal(fs.existsSync(lock), false);
});

test('file history recovery restores selected bytes and protects current edits without uploading', async t => {
  const f = fixture(t); const original = f.git(f.vault, 'rev-parse', 'HEAD');
  const { instance } = load({ home: f.dir, vault: f.vault });
  fs.writeFileSync(path.join(f.vault, 'note.md'), 'new work to protect\n');
  assert.equal(await instance.runAction('history'), true);
  assert.ok(instance.history.some(item => item.oid === original));
  assert.equal(await instance.runAction('history-files', { oid: original }), true);
  assert.ok(instance.historyFiles.some(item => item.path === 'note.md'));
  assert.equal(await instance.runAction('restore-history', { oid: original, path: 'note.md' }), true, instance.feedback);
  assert.equal(fs.readFileSync(path.join(f.vault, 'note.md'), 'utf8'), 'original\n');
  const copies = path.join(f.vault, '.git', 'vault-sync', 'copies');
  assert.ok(fs.readdirSync(copies).some(folder => fs.readFileSync(path.join(copies, folder, 'content'), 'utf8') === 'new work to protect\n'));
  assert.equal(f.git(f.remote, 'rev-parse', 'main'), original);
});
