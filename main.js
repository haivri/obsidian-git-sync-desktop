// One installable runtime serves Obsidian and the closed-app background helper.
const HEADLESS = typeof require !== 'undefined' && require.main === module;
const { Notice, Plugin, Platform, Modal, PluginSettingTab, Setting } = HEADLESS
  ? { Notice: class { setMessage() {} hide() {} }, Plugin: class {}, Platform: { isMobile: false }, Modal: class {}, PluginSettingTab: class {}, Setting: class {} }
  : require('obsidian');
const COMMAND_NAME = 'Sync vault with Git';
const LFS_EXTENSIONS = 'jpg jpeg png gif webp heic tif tiff mp3 m4a wav flac ogg mp4 mov mkv webm pdf zip 7z rar';
const SETUP_IGNORES = ['.DS_Store', 'Thumbs.db', 'Desktop.ini', '.trash/', '.obsidian/workspace.json', '.obsidian/workspace-mobile.json', '.obsidian/workspaces.json', '.obsidian/cache/', '.obsidian/plugins/*/cache/', '.obsidian/plugins/*/.cache/'];

module.exports = class VaultGitSyncPlugin extends Plugin {
  syncing = false;
  feedback = 'Ready. Sync now saves, combines, and uploads. Manual actions let you do each step separately.';
  listeners = new Set();

  report(message) {
    this.feedback = message;
    for (const listener of this.listeners) listener();
  }

  supported() {
    return !Platform.isMobile && typeof process !== 'undefined'
      && ['darwin', 'win32', 'linux'].includes(process.platform);
  }

  onload() {
    if (!this.supported()) return;
    this.addRibbonIcon('git-merge', COMMAND_NAME, () => this.syncVault());
    this.addCommand({ id: 'sync-vault-with-git', name: COMMAND_NAME,
      callback: () => this.syncVault() });
    this.addSettingTab(new SyncSettingsTab(this.app, this));
    this.addCommand({ id: 'sync-status', name: 'Show save status', callback: () => new SyncHomeModal(this.app, this).open() });
    if (this.app.workspace?.onLayoutReady) this.app.workspace.onLayoutReady(() => this.startAutomation());
    this.addCommand({ id: 'setup-vault-sync', name: 'Set up vault sync', callback: () => new SetupModal(this.app, this).open() });
    this.addCommand({ id: 'manual-git-tools', name: 'Open manual Git tools', callback: () => new SyncToolsModal(this.app, this).open() });
    for (const action of ACTIONS) this.addCommand({ id: `manual-${action.id}`, name: action.title, callback: () => this.runAction(action.id) });
    this.addCommand({ id: 'force-merge', name: 'Force merge: choose conflict preference', callback: () => new ForceMergeModal(this.app, this).open() });
  }

  async syncVault() { return this.runAction('sync'); }

  async runAction(action, options = {}) {
    const result = await SyncEngine.prototype.runAction.call(this, action, options);
    if (this.app.workspace) this.announceAttention(options.automatic);
    if (this.app.workspace && this.attention?.kind === 'conflicts' && !options.automatic && !this.reviewOpen) this.openConflictReview();
    if (this.app.workspace && this.attention?.kind === 'deletions' && !options.automatic && !this.reviewOpen) new DeletionReviewModal(this.app, this).open();
    return result;
  }
  // An automatic run never opens a window over your writing. It leaves one
  // quiet notice with a button, and removes it once nothing needs you.
  announceAttention(automatic) {
    if (!this.attention) { this.attentionNotice?.hide(); this.attentionNotice = null; this.attentionAt = 0; return; }
    if (!this.attentionAt) this.attentionAt = Date.now();
    if (!automatic || this.reviewOpen || this.attentionNotice) return;
    const count = this.attention.paths?.length || 1;
    const notice = new Notice(`Sync is paused: ${count === 1 ? '1 file needs' : `${count} files need`} your choice. Nothing is lost.`, 0);
    const host = notice.messageEl || notice.noticeEl;
    const button = host?.createEl?.('button', { text: 'Choose now', cls: 'mod-cta vault-sync-notice-button' });
    button?.addEventListener('click', event => {
      event.stopPropagation(); notice.hide(); this.attentionNotice = null;
      if (this.attention?.kind === 'conflicts') this.openConflictReview(); else void this.syncVault();
    });
    this.attentionNotice = notice;
  }
  openConflictReview() { const modal = new ConflictReviewModal(this.app, this); modal.open(); return modal; }
  openReplacementReview(fingerprint) { const modal = new IncomingReplacementModal(this.app, this, fingerprint); modal.open(); return modal; }
  openSetup() { new SetupModal(this.app, this).open(); }
  startAutomation() {
    const fs = require('node:fs/promises'); const path = require('node:path'); const os = require('node:os');
    const vault = this.app.vault.adapter.getBasePath();
    const state = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'ObsidianVaultSync') : path.join(process.env.LOCALAPPDATA || process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), 'ObsidianVaultSync');
    const file = path.join(state, require('node:crypto').createHash('sha256').update(vault).digest('hex') + '.json');
    this.statusItem = this.addStatusBarItem?.();
    this.statusItem?.addEventListener('click', () => new SyncHomeModal(this.app, this).open());
    const changed = () => { this.lastEdit = Date.now(); if (this.outcome?.kind === 'complete') { this.outcome = { kind: 'pending' }; this.report('New edits are waiting to sync.'); } };
    for (const event of ['modify', 'create', 'delete', 'rename']) this.registerEvent(this.app.vault.on(event, changed));
    let lastRemote = 0; let retryAt = 0; let failures = 0; let seen = 0;
    const poll = async () => {
      if (this.syncing) return;
      let helper = false;
      try { const h = JSON.parse(await fs.readFile(file + '.helper', 'utf8')); helper = Date.now() - h.date < 20000; } catch { }
      if (helper) {
        try {
          const record = JSON.parse(await fs.readFile(file, 'utf8'));
          if (record.date > seen && (!this.lastEdit || this.lastEdit <= record.date)) {
            seen = record.date; this.savedAt = record.savedAt; this.verifiedAt = record.verifiedAt; this.verifiedSHA = record.verifiedSHA;
            this.outcome = { kind: record.kind === 'complete' && !record.verifiedAt ? 'local' : record.kind };
            const label = { complete: 'All saved — you’re all set.', local: 'Saved here. Waiting to upload.', pending: 'New edits are waiting to sync.', attention: 'Some files need your review.', failed: 'Sync needs attention.' };
            this.report((label[this.outcome.kind] || 'Checking your vault…') + ' ' + savedTimes(this));
          }
        } catch { }
      } else if ((!this.attention || (this.lastEdit && this.lastEdit > (this.attentionAt || 0) && Date.now() - this.lastEdit >= 45000 && (this.attentionAt = Date.now()))) && Date.now() >= retryAt && ((this.lastEdit && Date.now() - this.lastEdit >= 45000) || (failures > 0 && Date.now() >= retryAt) || Date.now() - lastRemote >= 600000)) {
        const started = Date.now(); const ok = await this.runAction('sync', { automatic: true }); lastRemote = Date.now();
        if (ok && this.lastEdit <= started) this.lastEdit = 0;
        failures = ok ? 0 : failures + 1;
        retryAt = Date.now() + (failures ? [60000, 300000, 900000][Math.min(failures - 1, 2)] : 0);
      }
      if (this.statusItem) { this.statusItem.textContent = ({ complete: 'All saved', local: 'Saved here · waiting to upload', pending: 'Edits waiting to sync', attention: 'Your choice is needed', syncing: 'Saving…', failed: 'Sync needs attention' })[this.outcome?.kind] || 'Checking save status'; this.statusItem.setAttribute('aria-label', this.feedback + ' ' + savedTimes(this) + ' Open sync status'); this.statusItem.setAttribute('title', savedTimes(this)); }
    };
    this.automationTimer = setInterval(() => void poll(), 5000); void poll();
  }
  onunload() { clearInterval(this.automationTimer); }


};

class SyncEngine {
  syncing = false;
  listeners = new Set();
  feedback = 'Checking vault…';
  report(message) { this.feedback = message; for (const listener of this.listeners) listener(); }
  supported() { return ['darwin', 'win32', 'linux'].includes(process.platform); }
  openSetup() {}
  async runAction(action, options = {}) {
    if (!['sync', 'commit', 'pull', 'merge', 'push', 'status', 'finish', 'force', 'inspect', 'prepare', 'connect', 'upload', 'review', 'resolve', 'recover', 'replacement-preview', 'whole-preview', 'approve-deletions', 'merge-protected', 'history', 'history-files', 'restore-history', 'recovery-notes', 'note-history', 'recovery-preview', 'restore-selection'].includes(action)) return false;
    if (action === 'force' && !['ours', 'theirs'].includes(options.preference)) return false;
    if (!this.supported()) {
      new Notice('Git Sync Desktop requires desktop Obsidian on macOS, Windows, or Linux.', 10000);
      return false;
    }
    if (this.syncing) {
      new Notice('Vault sync is already running.');
      return false;
    }
    const previousOutcome = this.outcome;
    const previousFeedback = this.feedback;
    this.syncing = true;
    this.attention = null;
    this.outcome = { kind: 'syncing' };
    this.report('Checking vault…');
    const progress = options.automatic ? { setMessage() {}, hide() {} } : new Notice('Checking vault…', 0);
    const { execFile } = require('node:child_process');
    const { promisify } = require('node:util');
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const os = require('node:os');
    const executeFile = promisify(execFile);
    const runFile = async (...args) => {
      const request = executeFile(...args);
      request.catch(() => {}); // Observe immediately while persisting ownership.
      if (ownsLock && request.child?.pid) await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, childPID: request.child.pid, started: Date.now() }));
      try { return await request; }
      finally { if (ownsLock && request.child?.pid) await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started: Date.now() })); }
    };
    // Keep the Mac path compatible with the existing watcher and shortcut.
    const state = process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'ObsidianVaultSync')
      : path.join(process.platform === 'win32'
        ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
        : (process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state')), 'ObsidianVaultSync');
    const lock = path.join(state, 'sync.lock');
    let ownsLock = false;
    let publishState = async () => {};
    let localSaved = false;
    let phase = 'Checking vault';
    const status = (message) => { phase = message; progress.setMessage(`${message}…`); this.report(`${message}…`); };
    const done = (message) => { this.report(message); if (!options.automatic) new Notice(message, 10000); return true; };
    try {
      const vaultPath = this.app.vault.adapter.getBasePath?.();
      if (!vaultPath) throw new Error('This vault has no local filesystem path.');
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no', LC_ALL: 'C' };
      if (process.platform === 'darwin') {
        env.PATH = `/opt/homebrew/bin:/usr/local/bin:${env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`;
      }
      const executable = process.platform === 'darwin' ? '/usr/bin/git'
        : process.platform === 'win32' ? 'git.exe' : 'git';
      const gitBytes = async (...args) => (await runFile(executable, args, { cwd: vaultPath, env, timeout: 600000, windowsHide: true, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })).stdout;
      const git = async (...args) => {
        const opts = { cwd: vaultPath, env, timeout: 600000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 };
        const before = args[0] === 'merge' ? (await runFile(executable, ['rev-parse', 'HEAD'], opts)).stdout.trim() : null;
        const result = (await runFile(executable, args, opts)).stdout.trim();
        if (args[0] === 'commit' || (before && (await runFile(executable, ['rev-parse', 'HEAD'], opts)).stdout.trim() !== before)) this.savedAt = Date.now();
        return result;
      };
      await fs.mkdir(state, { recursive: true });
      try {
        await fs.mkdir(lock); ownsLock = true;
        await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started: Date.now() }));
      }
      catch (error) {
        if (error.code === 'EEXIST') {
          // Never break a legacy/unknown lock. A proven dead owner can be recovered.
          let owner;
          try { owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')); } catch { }
          if (Number.isInteger(owner?.pid) && owner.pid > 0 && typeof process.kill === 'function') {
            const dead = pid => {
              if (!Number.isInteger(pid) || pid <= 0) return false;
              try { process.kill(pid, 0); return false; } catch (check) { return check.code === 'ESRCH'; }
            };
            if (dead(owner.pid) && (!owner.childPID || dead(owner.childPID))) {
              const gate = lock + '.reclaim'; let reclaim = false;
              try {
                await fs.mkdir(gate); reclaim = true;
                const current = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8'));
                if (JSON.stringify(current) === JSON.stringify(owner) && dead(current.pid) && (!current.childPID || dead(current.childPID))) {
                  await fs.rename(lock, `${lock}.abandoned-${Date.now()}`);
                  await fs.mkdir(lock); ownsLock = true;
                  await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, started: Date.now() }));
                }
              } catch (recoveryError) { if (recoveryError.code !== 'EEXIST' && recoveryError.code !== 'ENOENT') throw recoveryError; }
              finally { if (reclaim) await fs.rmdir(gate); }
            }
          }
          if (!ownsLock) throw new Error('Another vault sync is running. Try again after it finishes.');
        } else throw error;
      }
      await git('--version');
      const optional = async (...args) => {
        try { return await git(...args); }
        catch (error) { if (error.code === 1) return ''; throw error; }
      };
      let root;
      try { root = await git('rev-parse', '--show-toplevel'); }
      catch (error) {
        if (!String(error.stderr).includes('not a git repository')) throw error;
        // A broken .git entry must never be mistaken for a fresh vault.
        try { await fs.lstat(path.join(vaultPath, '.git')); throw new Error('This vault has Git metadata that needs repair in a Git client.'); }
        catch (entryError) { if (entryError.code !== 'ENOENT') throw entryError; }
      }
      const readText = async (name) => {
        try { return await fs.readFile(path.join(vaultPath, name), 'utf8'); }
        catch (error) { if (error.code === 'ENOENT') return ''; throw error; }
      };
      if (root && await fs.realpath(root) !== await fs.realpath(vaultPath)) {
        throw new Error('The vault must be the root of its own Git repository. Move it outside the parent repository before setup.');
      }
      if (action === 'inspect') {
        const name = await optional('config', 'user.name');
        const email = await optional('config', 'user.email');
        let lfs = false;
        try { await git('lfs', 'version'); lfs = true; } catch { /* Show installation help. */ }
        this.setupState = { repository: !!root, name, email, lfs,
          pending: root ? await optional('config', '--local', '--get', 'gitSyncDesktop.setupPending') === 'true' : false,
          branch: root ? await git('branch', '--show-current') : 'main',
          remote: root ? redact(await optional('config', '--get', 'remote.origin.url')) : '',
          ignores: await readText('.gitignore'),
          excluded: root ? await git('ls-files', '--others', '--ignored', '--exclude-standard') : '',
          attributes: await readText('.gitattributes') };
        this.uploadPreview = root ? {
          remote: await optional('config', '--get', 'remote.origin.url'), branch: this.setupState.branch,
          text: `Destination: ${this.setupState.remote || '(not connected)'}\nBranch: ${this.setupState.branch}\n\nFiles included in the vault:\n${await git('ls-files', '--cached', '--others', '--exclude-standard')}\n\nPending changes:\n${await git('status', '--short') || '(none)'}`,
        } : null;
        return done(lfs ? 'Checks complete. Review the setup steps below.' : 'Git LFS is missing. Install it, restart Obsidian, then check again.');
      }
      if (!root && !['prepare'].includes(action)) {
        if (action === 'sync') this.openSetup();
        throw new Error('This vault is not set up yet. Open Set up vault sync to create its local repository.');
      }
      if (action === 'prepare') {
        if (root) {
          const metadata = await git('rev-parse', '--absolute-git-dir');
          for (const marker of ['MERGE_HEAD', 'MERGE_AUTOSTASH', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
            try { await fs.access(path.join(metadata, marker)); }
            catch (error) { if (error.code === 'ENOENT') continue; throw error; }
            throw new Error('Finish the existing Git operation in a Git client before setup.');
          }
          if (await git('diff', '--name-only', '--diff-filter=U')) throw new Error('Resolve existing conflicts before setup.');
        }
        await git('lfs', 'version').catch(() => { throw new Error('Install Git LFS, restart Obsidian, then check again.'); });
        const name = (options.name || await optional('config', 'user.name')).trim();
        const email = (options.email || await optional('config', 'user.email')).trim();
        if (!name || !email || /[\r\n\0]/.test(name + email)) throw new Error('Enter your Git author name and email before setup.');
        const extensions = [...new Set(String(options.extensions ?? LFS_EXTENSIONS).toLowerCase().split(/[\s,]+/).filter(Boolean))];
        if (extensions.length > 64 || extensions.some(ext => !/^[a-z0-9]{1,8}$/.test(ext))) throw new Error('Use up to 64 extensions of 1–8 letters or digits, separated by spaces, without dots or wildcards.');
        if (!root) {
          status('Creating local repository');
          await git('init', '--initial-branch=main');
          root = vaultPath;
          await git('config', '--local', 'gitSyncDesktop.setupPending', 'true');
        } else if (await optional('config', '--local', '--get', 'gitSyncDesktop.setupPending') !== 'true') {
          return done('This vault already has a repository. Existing rules and history are preserved. Use Connect your repository, or the manual Git tools.');
        }
        if (await optional('config', 'core.hooksPath')) throw new Error('A custom Git hooks directory is configured. Set up LFS with your Git client to preserve those shared hooks.');
        await git('config', '--local', 'user.name', name);
        await git('config', '--local', 'user.email', email);
        status('Enabling attachment storage');
        await git('lfs', 'install', '--local');
        // Add defaults only for our fresh/retry setup; preserve all existing lines.
        for (const filename of ['.gitignore', '.gitattributes']) {
          try { if ((await fs.lstat(path.join(vaultPath, filename))).isSymbolicLink()) throw new Error(`${filename} is a symbolic link. Review it in a Git client before setup.`); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const ignores = await readText('.gitignore');
        const missing = SETUP_IGNORES.filter(rule => !ignores.split(/\r?\n/).includes(rule));
        if (missing.length) await fs.appendFile(path.join(vaultPath, '.gitignore'), `${ignores && !ignores.endsWith('\n') ? '\n' : ''}${missing.join('\n')}\n`);
        // VaultBridge's matcher supports * and ?, but not bracket classes.
        // Explicit variants preserve mixed-case matching on both platforms.
        const patterns = extensions.flatMap(ext => [...ext].reduce((variants, character) =>
          variants.flatMap(prefix => character === character.toUpperCase() ? [prefix + character]
            : [prefix + character, prefix + character.toUpperCase()]), ['*.']));
        for (let i = 0; i < patterns.length; i += 128) await git('lfs', 'track', ...patterns.slice(i, i + 128));
        status('Saving first local checkpoint');
        await git('add', '--all');
        if (await git('diff', '--cached', '--name-only')) await git('commit', '-m', 'Set up vault sync');
        if (await git('status', '--porcelain')) throw new Error('Files changed during setup. Your checkpoint is safe; retry when editing settles.');
        await git('config', '--local', '--unset', 'gitSyncDesktop.setupPending');
        return done('Vault prepared. All unignored content and configuration are saved locally. Next: connect your repository. Nothing uploaded.');
      }
      if (await optional('config', '--local', '--get', 'gitSyncDesktop.setupPending') === 'true') throw new Error('Vault preparation is incomplete. Retry Set up this vault before syncing or uploading.');
      const gitDir = await git('rev-parse', '--absolute-git-dir');
      const safety = new SyncSafety({ fs, path, git, gitBytes, vaultPath, gitDir, onConflicts: entries => {
        this.attention = { kind: 'conflicts', paths: entries.map(x => x.path) };
        this.outcome = { kind: 'attention' };
      } });
      await safety.load();
      const statusFile = path.join(state, require('node:crypto').createHash('sha256').update(vaultPath).digest('hex') + '.json');
      this.statusFile = statusFile;
      try {
        const prior = JSON.parse(await fs.readFile(statusFile, 'utf8'));
        this.savedAt = prior.savedAt || this.savedAt; this.verifiedAt = prior.verifiedAt || this.verifiedAt;
        this.verifiedSHA = prior.verifiedSHA || this.verifiedSHA;
      } catch { }
      publishState = async () => {
        if (['history', 'history-files', 'recovery-notes', 'note-history', 'recovery-preview', 'replacement-preview', 'whole-preview'].includes(action)) return;
        // Persist only coarse state, never errors, paths or document contents.
        const data = { savedAt: this.savedAt || null, verifiedAt: this.verifiedAt || null, verifiedSHA: this.verifiedSHA || null, kind: this.outcome?.kind || 'idle', localSaved, date: Date.now(), attention: this.attention?.kind || null, count: this.attention?.paths?.length || 0 };
        await fs.writeFile(statusFile + '.tmp', JSON.stringify(data));
        await fs.rename(statusFile + '.tmp', statusFile);
      };
      if (action === 'recovery-notes') {
        const tracked = (await gitBytes('ls-files', '-z')).toString().split('\0');
        const deleted = (await gitBytes('log', '--all', '--diff-filter=D', '--name-only', '--format=', '-z', '--', '*.md')).toString().split('\0').map(x => x.replace(/^\n+/, ''));
        this.recoveryNotes = [...new Set([...tracked, ...deleted, ...(await safety.copies()).map(x => x.path)].filter(x => /\.md$/i.test(x)))].sort();
        this.outcome = previousOutcome; this.report(previousFeedback); return true;
      }
      if (action === 'note-history') {
        await safety.safePath(options.path);
        const rows = (await gitBytes('log', '--all', '-50', `--skip=${Math.max(0, Number(options.skip) || 0)}`, '--format=%H%x00%aI%x00%s%x00', '--', options.path)).toString().split('\0');
        this.history = [];
        for (let i = 0; i + 2 < rows.length; i += 3) {
          const oid = rows[i].trim();
          const exists = await safety.optional('rev-parse', `${oid}:${options.path}`);
          const source = exists ? oid : await safety.optional('rev-parse', `${oid}^`);
          if (source && await safety.optional('rev-parse', `${source}:${options.path}`)) this.history.push({ oid: source, date: rows[i + 1], subject: rows[i + 2] });
        }
        if (!options.skip) this.history.unshift(...(await safety.copies()).filter(x => x.path === options.path));
        this.historyHasMore = rows.length >= 150;
        this.outcome = previousOutcome; this.report(previousFeedback); return true;
      }
      if (action === 'recovery-preview' || action === 'whole-preview') {
        this.recoveryPreview = await safety.preview(options.path, options.oid, action === 'whole-preview');
        this.outcome = previousOutcome; this.report(previousFeedback); return true;
      }
      if (action === 'restore-selection') {
        await safety.restoreSelection(options);
        this.outcome = { kind: 'pending' }; return done('Selected changes restored locally. Sync when ready to upload.');
      }
      if (action === 'history') {
        const rows = (await gitBytes('log', '--all', '-30', '--format=%H%x00%aI%x00%s%x00')).toString().split('\0');
        this.history = [];
        for (let i = 0; i + 2 < rows.length; i += 3) this.history.push({ oid: rows[i].trim(), date: rows[i + 1], subject: rows[i + 2] });
        this.outcome = previousOutcome; this.report(previousFeedback); return true;
      }
      if (action === 'history-files') {
        if (!/^[a-f0-9]{40}$/.test(options.oid || '')) throw new Error('Choose a saved checkpoint.');
        const parents = (await git('rev-list', '--parents', '-n', '1', options.oid)).split(' ');
        const args = parents.length > 1 ? [parents[1], options.oid] : ['--root', options.oid];
        const rows = (await gitBytes('diff-tree', '--no-commit-id', '--name-status', '-z', '-r', ...args)).toString().split('\0');
        this.historyFiles = [];
        for (let i = 0; i + 1 < rows.length; i += 2) {
          const type = rows[i]; let name = rows[i + 1];
          if (/^[RC]/.test(type)) { name = rows[i + 2]; i++; }
          this.historyFiles.push({ path: name, oid: type === 'D' ? parents[1] : options.oid, deleted: type === 'D' });
        }
        this.outcome = previousOutcome; this.report(previousFeedback); return true;
      }
      if (action === 'restore-history') {
        if (!options.confirmReplacement) throw new Error('Preview and confirm whole-file replacement first.');
        await safety.restoreVersion(options.path, options.oid, options.fingerprint);
        this.outcome = { kind: 'pending' };
        return done('File restored on this computer. Sync when you’re ready to upload it.');
      }
      if (action === 'review') {
        this.review = await safety.conflicts();
        this.attention = this.review.length ? { kind: 'conflicts', paths: this.review.map(x => x.path) } : null;
        this.outcome = { kind: this.review.length ? 'attention' : 'pending' };
        return true;
      }
      if (action === 'resolve') {
        await safety.resolve(options);
        this.review = await safety.conflicts();
        this.outcome = { kind: this.review.length ? 'attention' : 'pending' };
        return done(this.review.length ? `${this.review.length} files still need your choice.` : 'Choices saved. Finish syncing to upload.');
      }
      if (action === 'replacement-preview') {
        this.replacementPreview = await safety.replacementPreview(options.fingerprint);
        this.outcome = previousOutcome; this.report(previousFeedback); return true;
      }
      if (action === 'merge-protected') {
        await safety.mergeProtected(options);
        this.outcome = { kind: 'pending' };
        return done('Your previewed note is saved on this computer. Ready to sync.');
      }
      if (action === 'recover') {
        if (!options.confirmReplacement) throw new Error('Preview and confirm whole-file replacement first.');
        await safety.restoreIncoming(options.fingerprint);
        this.outcome = { kind: 'pending' };
        return done('Protected files restored. Sync now to verify.');
      }
      if (action === 'approve-deletions') {
        await safety.approveLosses(options.fingerprint);
        this.outcome = { kind: 'pending' };
        return done('These exact changes are approved. Sync now to save them.');
      }
      let pendingOperation = false;
      for (const marker of ['MERGE_HEAD', 'MERGE_AUTOSTASH', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
        try { await fs.access(path.join(gitDir, marker)); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        pendingOperation = true;
        if (marker === 'MERGE_HEAD' && ['sync', 'finish', 'status'].includes(action)) continue;
        if (action === 'status') continue;
        throw new Error('Git has an unfinished operation. Resolve conflicts, then use Finish resolved merge. Other recovery operations must be completed in a Git client.');
      }
      const conflicts = await git('diff', '--name-only', '--diff-filter=U');
      if (conflicts && action !== 'status') {
        const entries = await safety.conflicts();
        this.attention = { kind: 'conflicts', paths: entries.map(x => x.path) };
        this.outcome = { kind: 'attention' };
        throw new Error(`${entries.length} files need your choice. Both versions are protected. Open Review conflicts to continue.`);
      }
      if (pendingOperation && action === 'sync') {
        if (await git('diff', '--name-only')) throw new Error('Files changed during the combine. Review them before finishing; nothing was uploaded.');
        await git('commit', '--no-edit');
        await safety.finishIntegration();
      }
      if (!['status', 'push', 'pull', 'finish'].includes(action)) {
        const losses = await safety.suspiciousLosses();
        if (losses) {
          this.attention = { kind: 'deletions', ...losses };
          this.outcome = { kind: 'attention' };
          throw new Error(losses.paths.length === 1 ? '1 file needs a quick look before it is saved. Nothing has been lost or uploaded.' : `${losses.paths.length} files need a quick look before they are saved. Nothing has been lost or uploaded.`);
        }
      }
      const branch = await git('branch', '--show-current');
      if (!branch) throw new Error('Check out a branch before syncing; Git is in detached HEAD state.');
      const origin = await optional('config', '--get', 'remote.origin.url');
      if (['connect', 'upload'].includes(action) && await optional('config', '--get-all', 'remote.origin.pushurl')) throw new Error('This repository has a separate push destination. Review its remote configuration in a Git client before using setup; existing destinations were preserved.');
      if (action === 'upload' && (options.expectedRemote !== origin || options.expectedBranch !== branch)) throw new Error('The destination or branch changed. Review the upload again before proceeding.');
      if (action === 'connect') {
        const url = validateRemote(options.url);
        if (origin && origin !== url && options.replace !== true) throw new Error('A remote is already configured. Use Replace remote explicitly to change it.');
        status('Checking repository access');
        const refs = await git('ls-remote', '--refs', url);
        if (refs) {
          const head = await git('rev-parse', 'HEAD');
          await git('fetch', '--no-tags', url, `refs/heads/${branch}`);
          try { await git('merge-base', head, 'FETCH_HEAD'); }
          catch { throw new Error('This repository contains unrelated history. Create an empty remote, or clone the existing repository into a separate vault.'); }
        }
        await git('remote', origin ? 'set-url' : 'add', 'origin', url);
        return done(refs ? 'Repository reachable and connected. Use Sync now to combine and upload related history.' : 'Empty repository reachable and connected. Next: Upload vault. Write access and attachment transfer will be checked during upload.');
      }
      if (!origin && ['sync', 'status', 'push', 'pull', 'merge', 'upload'].includes(action)) {
        if (action === 'sync') this.openSetup();
        return done('This vault is on this computer only; no remote is connected. Use Commit locally to save edits, or Set up vault sync to connect a remote.');
      }
      const localOnly = action === 'commit' || action === 'finish';
      if (!localOnly) await git('remote', 'get-url', 'origin');
      if (action !== 'status') {
        try { await git('lfs', 'version'); }
        catch { throw new Error('Git LFS is required. Install Git LFS and make it available on PATH, then retry.'); }
      }
      if (['status', 'push', 'upload'].includes(action)) {
        status('Checking server branch');
        const refs = await git('ls-remote', '--refs', 'origin');
        if (!refs || action === 'upload') {
          if (refs) throw new Error('The remote now contains history. Use Sync now for related history, or connect an empty repository.');
          if (action !== 'upload') return done('The remote is empty. Open Set up vault sync and choose Upload vault for the first upload.');
          status('Saving local changes');
          await git('add', '--all');
          if (await git('diff', '--cached', '--name-only')) await git('commit', '-m', `vault sync: ${new Date().toISOString()}`);
          if (await git('status', '--porcelain')) throw new Error('The vault changed while saving. Retry after editing settles.');
          if (await git('ls-remote', '--refs', 'origin')) throw new Error('The remote changed during setup. Check its history before uploading.');
          status('Uploading vault and attachments');
          await git('push', '--set-upstream', 'origin', `HEAD:refs/heads/${branch}`);
          const head = await git('rev-parse', 'HEAD');
          const remote = await git('ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`);
          if (remote.split(/\s+/)[0] !== head) throw new Error('The server changed again. Use Sync now to check the latest work.');
          return done(await git('status', '--porcelain') ? 'Vault uploaded; newer local edits need Sync now.' : `Ready to sync · ${head.slice(0, 8)}. Vault and LFS upload completed.`);
        }
      }
      const fetchRemote = async () => {
        status('Getting remote changes');
        await git('fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
        return git('rev-parse', `refs/remotes/origin/${branch}`);
      };
      if (action === 'status') {
        await fetchRemote();
        const counts = (await git('rev-list', '--left-right', '--count', `HEAD...refs/remotes/origin/${branch}`)).split(/\s+/).map(Number);
        const dirty = !!(await git('status', '--porcelain'));
        const next = pendingOperation ? 'Finish the current Git operation before starting another. Resolve and stage any conflicts first.' : conflicts ? 'Resolve conflicts in a Git client, then finish the merge.'
          : dirty ? 'Next: commit locally, or use Sync now.'
            : counts[0] && counts[1] ? 'Next: combine computer and server changes.'
              : counts[1] ? 'Next: pull newer server changes.' : counts[0] ? 'Next: push saved changes.' : 'Everything is up to date.';
        return done(`${dirty ? 'Unsaved local changes. ' : 'Local files are saved. '}${counts[0]} saved commits to upload; ${counts[1]} server commits to receive. ${next}`);
      }
      if (action === 'finish') {
        try { await fs.access(path.join(gitDir, 'MERGE_HEAD')); }
        catch { throw new Error('There is no merge to finish.'); }
        status('Finishing resolved merge');
        if (await git('diff', '--name-only')) throw new Error('Review files changed during the combine before finishing.');
        await git('commit', '--no-edit');
        await safety.finishIntegration();
        return done(`Merge saved locally · ${(await git('rev-parse', 'HEAD')).slice(0, 8)}. Nothing uploaded. Use Push when ready.`);
      }
      if (['pull', 'push'].includes(action)) {
        if (await git('status', '--porcelain')) throw new Error('Save your edits with Commit locally first. No files were pulled or uploaded.');
        const remoteHead = await fetchRemote();
        if (action === 'pull') {
          const ahead = Number(await git('rev-list', '--count', `${remoteHead}..HEAD`));
          if (ahead) throw new Error('This computer has saved work the server does not have. Use Merge to combine both histories, or Push if only this computer changed.');
          status('Bringing newer server changes here');
          await safety.beginIntegration(remoteHead);
          await git('merge', '--ff-only', '--no-autostash', remoteHead);
          await git('lfs', 'pull', 'origin');
          await safety.finishIntegration();
          return done(`Server changes received · ${(await git('rev-parse', 'HEAD')).slice(0, 8)}. Nothing uploaded.`);
        }
        const behind = Number(await git('rev-list', '--count', `HEAD..${remoteHead}`));
        if (behind) throw new Error('The server has newer work. Pull or Merge first, then Push. Server work has not been overwritten.');
      }
      // Network first for manual merging. A connection failure changes no local files.
      const mergeHead = ['merge', 'force'].includes(action) ? await fetchRemote() : null;
      if (action !== 'push') {
        status('Saving local changes');
        await git('add', '--all');
        const stagedLosses = await safety.suspiciousLosses();
        if (stagedLosses) { this.attention = { kind: 'deletions', ...stagedLosses }; this.outcome = { kind: 'attention' }; throw new Error('Files changed while saving. Review the latest changes.'); }
        if (await git('diff', '--cached', '--name-only')) {
          await git('commit', '-m', `vault sync: ${new Date().toISOString()}`);
        }
        if (await git('status', '--porcelain')) {
          throw new Error('The vault changed while saving. Your checkpoint is safe; run sync again.');
        }
        await safety.settleApproval();
        localSaved = true;
        this.outcome = { kind: 'local' };
        if (action === 'commit') return done(`Saved locally · ${(await git('rev-parse', 'HEAD')).slice(0, 8)}. Nothing uploaded.`);
      }
      if (mergeHead) {
        const checkpoint = `refs/vault-git-sync/checkpoints/${Date.now()}`;
        const checkpointHead = await git('rev-parse', 'HEAD');
        await git('update-ref', checkpoint, checkpointHead);
        status('Combining computer and server changes');
        const args = ['merge', '--no-edit', '--no-autostash'];
        if (action === 'force') args.push(`-X${options.preference}`);
        await safety.beginIntegration(mergeHead);
        try {
          try { await git(...args, mergeHead); }
          catch (error) { await safety.combineConflicts(error); }
          await git('lfs', 'pull', 'origin'); await safety.finishIntegration();
        }
        catch (error) { throw new Error(`Merge stopped. Restore point ${checkpointHead.slice(0, 8)} protects your saved computer version. Nothing uploaded. ${String(error.stderr || error.message).trim()}`, { cause: error }); }
        return done(`Combined locally · ${(await git('rev-parse', 'HEAD')).slice(0, 8)}. Nothing uploaded. Restore point: ${checkpointHead.slice(0, 8)}. Use Push when ready.`);
      }
      if (action === 'sync') {
        status('Getting remote changes');
        if (!await git('ls-remote', '--refs', 'origin')) {
          this.openSetup();
          return done('Saved locally. The remote is empty; review the first upload in Set up vault sync.');
        }
        const incoming = await fetchRemote();
        await safety.beginIntegration(incoming);
        try { await git('merge', '--no-edit', '--no-autostash', incoming); }
        catch (error) {
          await safety.combineConflicts(error);
        }
        await safety.finishIntegration();
      }
      await git('lfs', 'pull', 'origin');
      await git('lfs', 'fsck', '--objects', 'HEAD');
      status('Uploading changes');
      await git('push', 'origin', `HEAD:refs/heads/${branch}`);
      status('Verifying sync');
      const head = await git('rev-parse', 'HEAD');
      const remote = await git('ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`);
      if (remote.split(/\s+/)[0] !== head) {
        throw new Error('The server changed again. Run sync again to receive the latest edits.');
      }
      const changed = await git('status', '--porcelain') || ((await git('rev-parse', 'HEAD')) !== head);
      if (!changed) { this.verifiedAt = Date.now(); this.verifiedSHA = head; }
      this.outcome = { kind: changed ? 'pending' : 'complete', verifiedSHA: changed ? null : head };
      done(changed ? 'Saved work uploaded. New edits are still being saved.' : 'All saved — you’re all set. This computer and the server match.');
      return !changed;
    } catch (error) {
      if (!this.attention) this.outcome = { kind: localSaved ? 'local' : 'failed' };
      const detail = redact(String(error.stderr || error.message || error)).trim();
      this.report(`${phase} stopped: ${detail.slice(-1800)}`);
      if (!options.automatic) new Notice(this.feedback, 20000);
      return false;
    } finally {
      await publishState().catch(() => {});
      if (ownsLock) {
        try { await fs.unlink(path.join(lock, 'owner.json')).catch(() => {}); await fs.rmdir(lock); }
        catch { new Notice('Sync ended, but its lock could not be released. Check the desktop sync helper.', 10000); }
      }
      progress.hide();
      this.syncing = false;
      this.report(this.feedback);
    }
  }
}

const ACTIONS = [
  { id: 'status', title: 'Check what needs doing', button: 'Check status', description: 'Checks the server and tells you whether to save, pull, combine, or upload. Does not change your notes.' },
  { id: 'commit', title: 'Save on this computer only', button: 'Commit locally', description: 'Saves every changed or new, unignored file as a local restore point. Works offline and uploads nothing.' },
  { id: 'pull', title: 'Bring newer server changes here', button: 'Pull', description: 'Downloads changes when this computer has no unsaved edits or competing commits. Does not upload or rewrite your history.' },
  { id: 'merge', title: 'Combine computer and server changes', button: 'Merge', description: 'Checks the server, saves your edits, then combines both histories here. Conflicts stop for review. Nothing is uploaded.' },
  { id: 'push', title: 'Upload saved work', button: 'Push', description: 'Checks the server, then uploads existing local commits. Save your edits first. Newer server work blocks the upload.' },
  { id: 'finish', title: 'Finish a resolved merge', button: 'Finish merge', description: 'After resolving and staging conflicted files in a Git client, saves the merge locally. Uploading is still a separate step.' },
];

function redact(value) {
  return value.replace(/(https?:\/\/)[^\s/]*@/gi, '$1[redacted]@').replace(/([?&](?:token|access_token|password)=)[^\s&]+/gi, '$1[redacted]');
}

function validateRemote(value) {
  const url = String(value || '').trim();
  if (!url || /[\s\0]/.test(url) || url.startsWith('-')) throw new Error('Paste an HTTPS or SSH clone URL.');
  if (/^https:\/\//i.test(url)) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search || parsed.hash || !parsed.hostname || parsed.pathname === '/') throw new Error('Use a plain clone URL without credentials, query parameters, or fragments. Sign in through your system Git credentials.');
  } else if (/^ssh:\/\//i.test(url)) {
    const parsed = new URL(url);
    if (parsed.password || parsed.search || parsed.hash || !parsed.hostname || parsed.pathname === '/') throw new Error('Use an SSH clone URL without passwords or query parameters.');
  } else if (!/^[\w.-]+@[\w.-]+:[^\s]+$/.test(url)) {
    throw new Error('Use an HTTPS or SSH clone URL from your repository host.');
  }
  return url;
}

class SetupModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; this.fields = { extensions: LFS_EXTENSIONS }; }
  onOpen() {
    this.setTitle('Set up vault sync');
    this.closed = false;
    this.render();
    // A ribbon action can still own the shared operation lock while opening us.
    this.timer = setTimeout(() => this.check(), 0);
  }
  async check() {
    await this.plugin.runAction('inspect');
    if (this.closed) return;
    const state = this.plugin.setupState;
    if (state) for (const key of ['name', 'email', 'remote']) this.fields[key] ??= state[key];
    this.render();
  }
  async act(action, options) {
    const success = await this.plugin.runAction(action, options);
    const feedback = this.plugin.feedback;
    if (success) {
      await this.plugin.runAction('inspect');
      this.plugin.report(feedback);
      this.reviewed = null;
    }
    if (!this.closed) this.render();
  }
  render() {
    this.cleanup?.();
    const shell = this.contentEl;
    let container = shell;
    container.empty();
    container.addClass('vault-git-sync-tools');
    const state = this.plugin.setupState;
    const buttons = [];
    const feedback = container.createDiv({ cls: 'vault-git-sync-feedback', attr: { role: 'status', 'aria-live': 'polite' } });
    const button = (name, description, label, callback) => new Setting(container).setName(name).setDesc(description).addButton(control => {
      buttons.push(control); control.setButtonText(label).onClick(callback);
    });
    const field = (name, description, key) => new Setting(container).setName(name).setDesc(description).addText(control => {
      control.setValue(this.fields[key] || '').onChange(value => { this.fields[key] = value; });
    });
    const step = (title, open) => {
      container = shell.createEl('details', { cls: 'vault-git-sync-step' });
      container.open = open;
      container.createEl('summary', { text: title });
    };
    step('1. Prepare this vault', !state?.repository || state.pending);
    container.createEl('p', { text: 'All unignored vault content is included: notes, every attachment type, hidden files, settings, themes, and plugins. LFS rules change storage, not which files are included.' });
    container.createEl('p', { text: state ? `Git available. Git LFS ${state.lfs ? 'available' : 'missing'}. ${state.repository ? 'Existing repository detected; its rules and history are preserved.' : 'A new local repository will use branch main.'}` : 'Check this computer before setup.' });
    container.createEl('p', { text: 'Install Git and Git LFS using the official guides below, then restart Obsidian. For sign-in, use your Git client or system credential manager; this plugin does not store passwords or tokens.' });
    for (const [text, href] of [['Install Git', 'https://git-scm.com/downloads'], ['Install Git LFS', 'https://git-lfs.com/'], ['GitHub authentication', 'https://docs.github.com/en/authentication'], ['Forgejo setup', 'https://forgejo.org/docs/latest/user/']]) container.createEl('a', { text: `${text} ↗ `, href });
    button('Computer checks', 'You can repeat these checks after installing software or fixing sign-in.', 'Check again', () => this.check());
    field('Author name', 'Shown on your Git commits; saved only in this repository.', 'name');
    field('Author email', 'Use your preferred commit email, including a host-provided private email if desired.', 'email');
    field('Attachment extensions for LFS', 'Space-separated extensions. Other file types still sync through ordinary Git. Applied only to a new repository.', 'extensions');
    const preview = container.createEl('details');
    preview.createEl('summary', { text: 'Review exclusions and existing attachment rules' });
    preview.createEl('p', { text: 'Fresh vaults exclude the following disposable files. Existing .gitignore rules are preserved and may exclude additional content. Git also respects global ignore rules and .git/info/exclude.' });
    preview.createEl('pre', { cls: 'vault-sync-recovery-text', text: SETUP_IGNORES.join('\n') });
    preview.createEl('pre', { cls: 'vault-sync-recovery-text', text: `Existing .gitignore:\n${state?.ignores || '(none)'}\n\nExisting .gitattributes:\n${state?.attributes || '(none)'}\n\nCurrently ignored files (existing repository):\n${state?.excluded || '(none detected; check again after preparation)'}` });
    button('Save on this computer', 'Creates a repository and first checkpoint with the reviewed rules. Nothing uploads.', 'Set up this vault', async () => {
      await this.act('prepare', this.fields);
    });
    step('2. Connect your repository', !!state?.repository && !state?.remote);
    container.createEl('p', { text: 'On GitHub or your Forgejo server, create a private repository. Leave it empty: do not add a README, license, or .gitignore. Copy its HTTPS or SSH clone URL below. Complete sign-in through your Git client first.' });
    container.createEl('p', { text: `Current destination: ${state?.remote || 'not checked or not connected'}. Branch: ${state?.branch || 'main'}.` });
    field('Repository URL', 'Uses origin in local Git configuration. Do not paste tokens or passwords.', 'remote');
    button('Test and connect', 'Checks read access before saving the remote. Upload will verify write access and LFS transfer.', 'Connect and check', () => this.act('connect', { url: this.fields.remote }));
    if (state?.remote) button('Change destination', 'Explicitly replaces the current origin after checking the new repository.', 'Replace remote', () => this.act('connect', { url: this.fields.remote, replace: true }));
    step('3. Upload and verify', !!state?.remote);
    container.createEl('p', { text: 'Review the current destination and files before the first upload. This saves all unignored changes and uploads the vault and LFS attachments to an empty remote. For a connected repository with related history, use Sync now.' });
    button('Review first upload', 'Shows the actual configured destination, branch, and pending files.', 'Review upload', async () => {
      const success = await this.plugin.runAction('inspect');
      this.reviewed = success ? this.plugin.uploadPreview : null;
      if (!this.closed) this.render();
    });
    if (this.reviewed) {
      container.createEl('pre', { cls: 'vault-sync-recovery-text', text: this.reviewed.text });
      button('Start first upload', 'Uploads to the reviewed destination. If it has changed, review it again.', 'Upload vault', () => this.act('upload', { expectedRemote: this.reviewed.remote, expectedBranch: this.reviewed.branch }));
    }
    button('Continue normal syncing', 'Saves, combines related history, and uploads.', 'Sync now', () => this.plugin.syncVault());
    const refresh = () => {
      feedback.textContent = this.plugin.feedback;
      feedback.setAttribute('aria-busy', String(this.plugin.syncing));
      for (const control of buttons) control.setDisabled(this.plugin.syncing);
    };
    this.plugin.listeners.add(refresh); refresh();
    this.cleanup = () => this.plugin.listeners.delete(refresh);
  }
  onClose() { this.closed = true; clearTimeout(this.timer); this.cleanup?.(); this.contentEl.empty(); }
}

function renderTools(container, plugin) {
  container.empty();
  container.addClass('vault-git-sync-tools');
  container.createEl('p', { text: 'Usually, Sync now is all you need. Use the individual steps when you want more control.' });
  const feedback = container.createDiv({ cls: 'vault-git-sync-feedback', attr: { role: 'status', 'aria-live': 'polite' } });
  const buttons = [];
  new Setting(container).setName('Vault setup and remote configuration').setDesc('Prepare the whole vault, connect a repository, and make the first upload.')
    .addButton(button => { buttons.push(button); button.setButtonText('Set up vault sync').onClick(() => new SetupModal(plugin.app, plugin).open()); });
  new Setting(container).setName('Save, combine, and upload').setDesc('Creates a local checkpoint, brings in server changes, and uploads the combined result. Stops if there are conflicts.')
    .addButton(button => { buttons.push(button); button.setButtonText('Sync now').setCta().onClick(() => plugin.syncVault()); });
  for (const action of ACTIONS) {
    new Setting(container).setName(action.title).setDesc(action.description).addButton(button => {
      buttons.push(button); button.setButtonText(action.button).onClick(() => plugin.runAction(action.id));
    });
  }
  const advanced = container.createEl('details', { cls: 'vault-git-sync-advanced' });
  advanced.createEl('summary', { text: 'Advanced: conflicting edits' });
  new Setting(advanced).setName('Force merge with a conflict preference')
    .setDesc('Combines both histories, preferring one side only where edits conflict. Creates a recovery checkpoint first. Does not force-push or replace the entire vault.')
    .addButton(button => { buttons.push(button); button.setButtonText('Choose preference…').onClick(() => new ForceMergeModal(plugin.app, plugin).open()); });
  const refresh = () => {
    feedback.textContent = plugin.feedback;
    feedback.setAttribute('aria-busy', String(plugin.syncing));
    for (const button of buttons) button.setDisabled(plugin.syncing);
  };
  plugin.listeners.add(refresh);
  refresh();
  return () => plugin.listeners.delete(refresh);
}

class SyncToolsModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  onOpen() { this.setTitle('Vault Git tools'); this.cleanup = renderTools(this.contentEl, this.plugin); }
  onClose() { this.cleanup?.(); this.contentEl.empty(); }
}

class SyncSettingsTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  getSettingDefinitions() {
    return [{ name: 'Manual Git actions', aliases: ['commit', 'pull', 'merge', 'force merge', 'push', 'sync'],
      render: (setting) => renderTools(setting.settingEl, this.plugin) }];
  }
  display() { this.cleanup?.(); this.cleanup = renderTools(this.containerEl, this.plugin); }
  hide() { this.cleanup?.(); this.cleanup = null; }
}

class ForceMergeModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  onOpen() {
    this.setTitle('Choose which conflicting edits to keep');
    this.contentEl.createEl('p', { text: 'Both histories are combined. Non-conflicting edits from both sides stay. For conflicting text, choose which side wins; for conflicting binary files, the chosen side supplies the whole file. Some conflicts still require manual resolution.' });
    this.contentEl.createEl('p', { text: 'Your current computer version is saved in a recovery checkpoint first. This never uploads or force-pushes. If a merge is already unfinished, resolve it before starting another.' });
    new Setting(this.contentEl).setName('Keep this computer’s conflicting edits')
      .addButton(button => button.setButtonText('Merge — prefer computer').onClick(() => this.confirm('ours')));
    new Setting(this.contentEl).setName('Keep the server’s conflicting edits')
      .addButton(button => button.setButtonText('Merge — prefer server').onClick(() => this.confirm('theirs')));
    new Setting(this.contentEl).addButton(button => button.setButtonText('Cancel').onClick(() => this.close()));
  }
  confirm(preference) { this.close(); void this.plugin.runAction('force', { preference }); }
  onClose() { this.contentEl.empty(); }
}

// Recovery text is local UI data; it must never enter the coarse sync journal.
function decodeNote(bytes) {
  if (bytes.length > 4 * 1024 * 1024) throw new Error('This note is too large for an inline preview. Use whole-file recovery.');
  const text = new (require('node:util').TextDecoder)('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('This file is not a text note.');
  return text;
}
function noteLines(text) { return text.replace(/\r\n/g, '\n').split('\n'); }
// Only Markdown list tasks outside fences are stateful. Keep all other bytes
// (including indentation, labels, duplicate counts and custom states) meaningful.
function taskLines(text) {
  let fence = null; let section = '';
  return noteLines(text).map(line => {
    const marker = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      return { line };
    }
    if (fence) return { line };
    if (/^\s{0,3}#{1,6}\s/.test(line)) section = line;
    const task = /^(\s*(?:[-+*]|\d+[.)])\s+\[)([^\]\r\n])(\]\s+)(.*)$/.exec(line);
    return task ? { line, task, section, key: JSON.stringify([section, task[1], task[3], task[4]]) } : { line };
  });
}
// Preserve complete words, punctuation and whitespace in order. Word tokens
// prevent a replacement such as "cat" -> "concatenate" from looking additive.
function insertionOnly(before, after) {
  if (before === after) return true;
  if (after.length <= before.length) return false;
  const tokens = text => text.match(/[\p{L}\p{N}\p{M}]+|[^\p{L}\p{N}\p{M}]/gu) || [];
  const original = tokens(before); let at = 0;
  for (const token of tokens(after)) if (at < original.length && token === original[at]) at++;
  return at === original.length;
}
// SYNC_RULES.md rule A. Ordinary editing is never a loss: Git keeps the
// received version, so rewording, ticking, moving or deleting a few lines saves
// silently. Only a note that went back to its older version, or lost most of
// its text with nothing in its place, stops for a person.
function noteLoss(expected, previous, current) {
  // Compare as a reader would: trailing spaces are not text, a tick is not wording.
  const content = text => noteLines(text).map(line => line.replace(/[ \t]+$/, '')).filter(Boolean)
    .map(line => line.replace(/^(\s*(?:[-+*]|\d+[.)])\s+\[)[^\]](\](?:\s|$))/, '$1 $2'));
  const absent = (wanted, text) => {
    const counts = new Map();
    for (const line of text) counts.set(line, (counts.get(line) || 0) + 1);
    return wanted.filter(line => { const n = counts.get(line) || 0; if (n) counts.set(line, n - 1); return !n; });
  };
  const received = content(expected), now = content(current);
  if (received.length === now.length && received.every((line, i) => line === now[i])) return null;
  if (typeof previous === 'string' && previous !== expected) {
    const before = content(previous), contributed = absent(received, before);
    // A stale editor buffer saved over the note has this exact shape:
    // everything the older version had is still here and everything the other
    // device added is gone. Ticks and new typing on top do not hide it.
    // A contributed line that was reworded here is an edit, not a dropped line.
    const words = line => new Set(line.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []);
    const similar = (a, b) => { const x = words(a), y = words(b); let shared = 0; for (const w of x) if (y.has(w)) shared++; return shared * 2 >= x.size + y.size - shared && shared > 0; };
    const fresh = absent(absent(now, before), received);
    const gone = absent(contributed, now).filter(line => !fresh.some(candidate => similar(line, candidate)));
    if (contributed.length && gone.length === contributed.length && !absent(before, now).length) {
      return { reason: 'This note went back to an older version', removed: contributed };
    }
  }
  if (received.length - now.length >= 10 && now.length * 2 <= received.length) return { reason: 'Most of this note was removed', removed: absent(received, now) };
  return null;
}
const trimEnd = line => line.replace(/[ \t\r]+$/, '');
const sameText = (a, b) => a.length === b.length && a.every((line, i) => trimEnd(line) === trimEnd(b[i]));
// True when every line of `small` appears in `large`, in order.
function containsLines(large, small) {
  let at = 0;
  for (const line of large) if (at < small.length && trimEnd(line) === trimEnd(small[at])) at++;
  return at === small.length;
}
// SYNC_RULES.md rule B for Obsidian settings: combine key by key. Two different
// values for one key keep the newer save; settings never interrupt the user.
function mergeSettings(baseText, localText, serverText, serverIsNewer) {
  let local, server, base;
  try { local = JSON.parse(localText); server = JSON.parse(serverText); } catch { return null; }
  try { base = baseText === null || baseText === undefined ? undefined : JSON.parse(baseText); } catch { base = undefined; }
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const plain = value => value && typeof value === 'object' && !Array.isArray(value);
  const combine = (b, l, r) => {
    if (equal(l, r) || equal(r, b)) return l;
    if (equal(l, b)) return r;
    if (!plain(l) || !plain(r)) return serverIsNewer ? r : l;
    const origin = plain(b) ? b : {}; const out = {};
    for (const key of [...new Set([...Object.keys(l), ...Object.keys(r)])]) {
      const inL = Object.prototype.hasOwnProperty.call(l, key), inR = Object.prototype.hasOwnProperty.call(r, key);
      const inB = Object.prototype.hasOwnProperty.call(origin, key);
      if (inL && inR) out[key] = combine(origin[key], l[key], r[key]);
      // A key one side removed and the other left alone stays removed.
      else if (inL) { if (!inB || !equal(l[key], origin[key])) out[key] = l[key]; }
      else if (!inB || !equal(r[key], origin[key])) out[key] = r[key];
    }
    return out;
  };
  const indent = /^\{\r?\n(\s+)"/.exec(localText)?.[1] ?? 2;
  return JSON.stringify(combine(base, local, server), null, indent) + (localText.endsWith('\n') ? '\n' : '');
}
function recoveryBlocks(current, historical) {
  const a = noteLines(current), b = noteLines(historical);
  if (a.length * b.length > 4000000) throw new Error('This comparison is too large for selective recovery. Use whole-file recovery.');
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  const blocks = []; let i = 0, j = 0;
  const add = (shared, left, right) => {
    let block = blocks[blocks.length - 1];
    if (!block || block.shared !== shared) { block = { id: blocks.length, shared, current: [], historical: [] }; blocks.push(block); }
    block.current.push(...left); block.historical.push(...right);
  };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { add(true, [a[i++]], [b[j++]]); }
    else if (i < a.length && (j === b.length || table[i + 1][j] >= table[i][j + 1])) add(false, [a[i++]], []);
    else add(false, [], [b[j++]]);
  }
  return blocks;
}
function renderRecovery(blocks, selected) { return blocks.flatMap(b => selected.has(b.id) ? b.historical : b.current).join('\n'); }

// Bounded diff3 following SYNC_RULES.md rule B: independent edits are retained
// and overlapping edits are compared to their common ancestor. Only a real
// clash of wording is left as a conflict.
function mergeNote(base, local, server) {
  const scalar = (b, l, r, normalize = x => x) => {
    if (normalize(l) === normalize(r) || normalize(r) === normalize(b)) return l;
    if (normalize(l) === normalize(b)) return r;
    return null;
  };
  const whole = scalar(base, local, server);
  if (whole !== null) return { blocks: [{ id: 0, result: whole, conflict: false }], clean: true };
  const b = noteLines(base), taskBase = taskLines(base), taskLocal = taskLines(local), taskServer = taskLines(server);
  const keyCounts = rows => {
    const counts = new Map();
    for (const row of rows) if (row.key) counts.set(row.key, (counts.get(row.key) || 0) + 1);
    return counts;
  };
  const counts = [taskBase, taskLocal, taskServer].map(keyCounts);
  const edits = (text, side) => {
    let start = 0, target = 0;
    return recoveryBlocks(base, text).flatMap(block => {
      const edit = { start, end: start + block.current.length, target, lines: block.historical, side };
      start = edit.end; target += block.historical.length;
      return block.shared ? [] : [edit];
    });
  };
  const changes = [...edits(local, 'local'), ...edits(server, 'server')].sort((a, c) => a.start - c.start || a.end - c.end);
  const blocks = []; let cursor = 0;
  const add = block => blocks.push({ id: blocks.length, ...block });
  while (changes.length) {
    const group = [changes.shift()]; const start = group[0].start; let end = group[0].end;
    while (changes.length && (changes[0].start < end || changes[0].start === start ||
      (changes[0].start === end && changes[0].start === changes[0].end))) {
      const next = changes.shift(); group.push(next); end = Math.max(end, next.end);
    }
    if (cursor < start) add({ result: b.slice(cursor, start), conflict: false });
    const variant = side => {
      const out = []; let at = start;
      for (const edit of group.filter(x => x.side === side)) {
        out.push(...b.slice(at, edit.start), ...edit.lines); at = edit.end;
      }
      out.push(...b.slice(at, end)); return out;
    };
    const original = b.slice(start, end), left = variant('local'), right = variant('server');
    let result = scalar(JSON.stringify(original), JSON.stringify(left), JSON.stringify(right));
    result = result === null ? null : JSON.parse(result);
    if (result === null && insertionOnly(original.join('\n'), left.join('\n')) && insertionOnly(original.join('\n'), right.join('\n'))) {
      if (insertionOnly(right.join('\n'), left.join('\n'))) result = left;
      else if (insertionOnly(left.join('\n'), right.join('\n'))) result = right;
    }
    if (result === null && original.length === left.length && original.length === right.length) {
      const combined = original.map((line, i) => {
        const ordinary = scalar(line, left[i], right[i]);
        if (ordinary !== null) return ordinary;
        const row = taskBase[start + i];
        const locate = side => {
          const edit = group.find(x => x.side === side && x.start <= start + i && x.end > start + i);
          if (!edit || edit.lines.length !== edit.end - edit.start) return null;
          return (side === 'local' ? taskLocal : taskServer)[edit.target + start + i - edit.start];
        };
        const l = locate('local'), r = locate('server');
        if (!row.task || !l?.task || !r?.task || counts[0].get(row.key) !== 1 ||
          counts[1].get(l.key) !== 1 || counts[2].get(r.key) !== 1) return null;
        // At least one side retains the original label and list structure.
        if (l.key !== row.key && r.key !== row.key) return null;
        const parts = [1, 2, 3, 4].map(n => scalar(row.task[n], l.task[n], r.task[n], n === 2 ? x => x === 'X' ? 'x' : x : x => x));
        // Both devices changed the state differently: a finished task stays finished.
        if (parts[1] === null) parts[1] = /^x$/i.test(l.task[2]) ? l.task[2] : /^x$/i.test(r.task[2]) ? r.task[2] : null;
        return parts.includes(null) ? null : parts.join('');
      });
      if (!combined.includes(null)) result = combined;
    }
    // Line endings and trailing spaces are not edits.
    if (result === null) {
      if (sameText(left, right) || sameText(right, original)) result = left;
      else if (sameText(left, original)) result = right;
    }
    // Both devices added different lines at the same place: keep everything,
    // the other device's lines first.
    if (result === null && !original.length) result = containsLines(left, right) ? left : containsLines(right, left) ? right : [...right, ...left];
    add({ base: original, local: left, server: right, result, conflict: result === null });
    cursor = end;
  }
  if (cursor < b.length) add({ result: b.slice(cursor), conflict: false });
  return { blocks, clean: blocks.every(block => !block.conflict) };
}
function renderMerge(merge, choices = {}) {
  return merge.blocks.flatMap(block => {
    if (!block.conflict) return block.result;
    const choice = choices[block.id];
    if (!['local', 'server', 'base', 'both'].includes(choice)) throw new Error('Choose a result for every conflicting section.');
    return choice === 'both' ? [...block.local, ...block.server] : block[choice];
  }).join('\n');
}
function savedTimes(plugin) {
  const format = time => time ? new Date(time).toLocaleString(undefined, { timeZoneName: 'short' }) : 'not yet verified';
  return `Saved locally at: ${format(plugin.savedAt)} · Server verified at: ${format(plugin.verifiedAt)}`;
}

// Private recovery metadata lives inside .git and is never synced or logged.
class SyncSafety {
  constructor(context) { Object.assign(this, context); this.directory = this.path.join(this.gitDir, 'vault-sync'); }
  async load() {
    await this.fs.mkdir(this.directory, { recursive: true });
    try { this.data = JSON.parse(await this.fs.readFile(this.path.join(this.directory, 'recovery.json'), 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.data = {}; }
  }
  async save() {
    const file = this.path.join(this.directory, 'recovery.json');
    await this.fs.writeFile(file + '.tmp', JSON.stringify(this.data));
    await this.fs.rename(file + '.tmp', file);
  }
  async safePath(name) {
    if (!name || this.path.isAbsolute(name) || name.split(/[\\/]/).some(x => x === '..' || x.toLowerCase() === '.git')) throw new Error('This file path is not safe to change.');
    const absolute = this.path.resolve(this.vaultPath, name);
    if (!absolute.startsWith(this.path.resolve(this.vaultPath) + this.path.sep)) throw new Error('This file is outside the vault.');
    let cursor = this.vaultPath;
    for (const component of this.path.relative(this.vaultPath, absolute).split(this.path.sep)) {
      cursor = this.path.join(cursor, component);
      try { if ((await this.fs.lstat(cursor)).isSymbolicLink()) throw new Error('Review symbolic links in a Git client.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return absolute;
  }
  async optional(...args) { try { return await this.git(...args); } catch { return null; } }
  async protect() {
    const head = await this.git('rev-parse', 'HEAD');
    await this.git('update-ref', `refs/vault-git-sync/checkpoints/${require('node:crypto').randomUUID()}`, head);
    return head;
  }
  async beginIntegration(remote) {
    if (this.data.pending) throw new Error('An interrupted combine needs review before another sync.');
    const before = await this.protect();
    await this.git('update-ref', `refs/vault-git-sync/checkpoints/${require('node:crypto').randomUUID()}-incoming`, remote);
    this.data.pending = { before, remote }; await this.save();
  }
  async finishIntegration() {
    if (!this.data.pending) return;
    if ((await this.conflicts()).length) throw new Error('Choose versions before finishing the combine.');
    // Do not stage materialization failures or concurrent writes as user edits.
    if (await this.git('diff', '--name-only')) throw new Error('Files changed while combining versions. Review them before syncing.');
    const after = await this.git('rev-parse', 'HEAD');
    const before = this.data.pending.before;
    await this.settleApproval();
    const names = (await this.gitBytes('diff', '--name-only', '-z', before, after)).toString().split('\0').filter(Boolean);
    this.data.incoming = (this.data.incoming || []).filter(entry => !names.includes(entry.path));
    for (const name of names) {
      const expected = await this.optional('rev-parse', `${after}:${name}`);
      if (expected) this.data.incoming.push({ path: name, expected, previous: await this.optional('rev-parse', `${before}:${name}`) });
    }
    this.data.pending = null; this.data.approved = null; await this.save();
  }
  async suspiciousLosses() {
    if (this.data.pending) {
      if (await this.optional('rev-parse', '-q', '--verify', 'MERGE_HEAD')) return null;
      const current = await this.git('rev-parse', 'HEAD');
      if (current === this.data.pending.before && !await this.git('diff', '--cached', '--name-only')) {
        this.data.pending = null; await this.save();
      } else await this.finishIntegration();
    }
    await this.settleApproval();
    const raw = (await this.gitBytes('status', '--porcelain=v1', '-z')).toString();
    const entries = raw.split('\0'); const deleted = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]; if (!e) continue;
      if (/[RC]/.test(e.slice(0, 2))) { i++; continue; }
      if (e.slice(0, 2).includes('D')) deleted.push(e.slice(3));
    }
    const total = (await this.gitBytes('ls-files', '-z')).toString().split('\0').filter(Boolean).length;
    const paths = new Set(deleted.length >= 20 || (deleted.length >= 5 && deleted.length / Math.max(total, 1) >= .2) ? deleted : []);
    const details = [];
    // Protection covers a received file only until this computer saves its own
    // version of it. After that both versions are in history, and keeping the
    // record would only turn later edits into questions.
    if (!this.data.approval && this.data.incoming?.length) {
      const saved = new Map();
      for (const row of (await this.gitBytes('ls-tree', '-r', '-z', 'HEAD')).toString().split('\0')) {
        const match = /^\d+ blob ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
        if (match) saved.set(match[2], match[1]);
      }
      const kept = this.data.incoming.filter(entry => saved.get(entry.path) === entry.expected);
      if (kept.length !== this.data.incoming.length) { this.data.incoming = kept; await this.save(); }
    }
    for (const entry of this.data.incoming || []) {
      const file = await this.safePath(entry.path);
      const indexOID = await this.optional('rev-parse', `:${entry.path}`);
      let bytes;
      try { bytes = await this.fs.readFile(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      let missing = !bytes || !indexOID;
      let lost = [];
      let reason = missing ? 'This file was deleted' : '';
      if (bytes && indexOID === entry.expected && await this.git('hash-object', '--path', entry.path, '--', file) === entry.expected) continue;
      if (/\.md$/i.test(entry.path)) {
        // A removed note keeps its reason; an edited note is judged by the
        // shape of the edit, never by the fact of it.
        if (!missing) try {
          const expected = decodeNote(await this.gitBytes('cat-file', 'blob', entry.expected));
          const previous = entry.previous ? decodeNote(await this.gitBytes('cat-file', 'blob', entry.previous)) : null;
          for (const candidate of [bytes, await this.gitBytes('cat-file', 'blob', indexOID)]) {
            const loss = noteLoss(expected, previous, decodeNote(candidate));
            if (loss) { reason = loss.reason; lost = loss.removed; break; }
          }
        } catch { reason = 'This note could not be read safely'; }
      } else if (bytes && !entry.path.startsWith('.obsidian/') && entry.previous && entry.previous !== entry.expected) {
        // Settings files are rewritten by Obsidian constantly; the newer value wins.
        const oid = await this.git('hash-object', '--path', entry.path, '--', file);
        if (oid === entry.previous || indexOID === entry.previous) reason = 'This file went back to an older version';
      }
      if (reason) { paths.add(entry.path); details.push({ path: entry.path, reason, removed: lost }); }
    }
    if (!paths.size) return null;
    const list = [...paths].sort();
    const fingerprintHash = require('node:crypto').createHash('sha256').update(await this.git('rev-parse', 'HEAD')).update(raw).update(await this.gitBytes('ls-files', '--stage', '-z')).update(JSON.stringify(this.data.incoming || [])).update(JSON.stringify(list));
    for (const name of list) {
      try { fingerprintHash.update(await this.fs.readFile(await this.safePath(name))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; fingerprintHash.update('missing'); }
    }
    const fingerprint = fingerprintHash.digest('hex');
    if (this.data.approved === fingerprint) return null;
    const approval = this.data.approval;
    if (approval && approval.head === await this.git('rev-parse', 'HEAD') && approval.protection === JSON.stringify(this.data.incoming || []) &&
      JSON.stringify(approval.versions.map(v => v.path).sort()) === JSON.stringify(list)) {
      let matches = true;
      for (const version of approval.versions) {
        let working = null;
        const file = await this.safePath(version.path);
        try { await this.fs.access(file); working = await this.git('hash-object', '--path', version.path, '--', file); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (working !== version.oid || await this.optional('rev-parse', `:${version.path}`) !== version.oid) matches = false;
      }
      if (matches) return null; // The authorized bytes were staged by this save.
    }
    return { paths: list, fingerprint, details };
  }
  async approveLosses(fingerprint) {
    const losses = await this.suspiciousLosses();
    if (!losses || losses.fingerprint !== fingerprint) throw new Error('The files changed. Review the latest changes first.');
    await this.protect();
    const versions = [];
    for (const name of losses.paths) {
      const file = await this.safePath(name);
      let oid = null;
      try { await this.fs.access(file); oid = await this.git('hash-object', '-w', '--path', name, '--', file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      versions.push({ path: name, oid });
    }
    this.data.approval = { head: await this.git('rev-parse', 'HEAD'), versions, protection: JSON.stringify(this.data.incoming || []) };
    this.data.approved = fingerprint; await this.save();
  }
  async settleApproval() {
    const approval = this.data.approval;
    if (!approval || await this.git('rev-parse', 'HEAD') === approval.head) return;
    for (const version of approval.versions) {
      if (await this.optional('rev-parse', `HEAD:${version.path}`) !== version.oid) return;
    }
    const paths = new Set(approval.versions.map(x => x.path));
    // The approved version is this computer's own work now; it is not
    // protected again, so the next edit never asks twice.
    this.data.incoming = (this.data.incoming || []).filter(x => !paths.has(x.path));
    this.data.approval = null; this.data.approved = null; await this.save();
  }
  async fingerprint(name) {
    const file = await this.safePath(name);
    const hash = require('node:crypto').createHash('sha256').update(await this.git('rev-parse', 'HEAD'))
      .update(await this.gitBytes('ls-files', '--stage', '-z')).update(JSON.stringify(this.data.incoming || []));
    try { hash.update(await this.fs.readFile(file)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; hash.update('missing'); }
    return hash.digest('hex');
  }
  async copies() {
    const folder = this.path.join(this.directory, 'copies');
    let names; try { names = await this.fs.readdir(folder); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const name of names) {
      if (!/^[a-f0-9-]{36}$/.test(name)) continue;
      const dir = this.path.join(folder, name);
      if ((await this.fs.lstat(dir)).isSymbolicLink()) continue;
      let metadata;
      try { metadata = JSON.parse(await this.fs.readFile(this.path.join(dir, 'source.json'), 'utf8')); await this.fs.access(this.path.join(dir, 'content')); }
      catch { continue; } // An interrupted backup must not hide intact versions.
      if (typeof metadata.path !== 'string' || !Number.isFinite(metadata.date)) continue;
      records.push({ path: metadata.path, oid: `copy:${name}`, date: new Date(metadata.date).toISOString(), subject: 'Protected before restoration' });
    }
    return records.sort((a, b) => b.date.localeCompare(a.date));
  }
  async sourceBytes(name, source) {
    if (/^[a-f0-9]{40}$/.test(source)) return this.gitBytes('show', `${source}:${name}`);
    if (!/^copy:[a-f0-9-]{36}$/.test(source) || !(await this.copies()).some(x => x.oid === source && x.path === name)) throw new Error('Choose a saved version of this note.');
    const file = this.path.join(this.directory, 'copies', source.slice(5), 'content');
    if ((await this.fs.lstat(file)).isSymbolicLink()) throw new Error('Recovery copy uses a symbolic link.');
    return this.fs.readFile(file);
  }
  async preview(name, commit, whole = false) {
    const file = await this.safePath(name);
    const fingerprint = await this.fingerprint(name);
    let current = require('node:buffer').Buffer.alloc(0);
    try { current = await this.fs.readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const historical = await this.sourceBytes(name, commit);
    let blocks = null;
    try { blocks = recoveryBlocks(decodeNote(current), decodeNote(historical)); }
    catch (error) { if (!whole) throw error; }
    if (await this.fingerprint(name) !== fingerprint) throw new Error('The note changed. Open its preview again.');
    return { path: name, commit, fingerprint, blocks, currentBytes: current.length, replacementBytes: historical.length };
  }
  async restoreSelection(options) {
    if (this.data.pending || (await this.conflicts()).length) throw new Error('Finish the current combine first.');
    const preview = await this.preview(options.path, options.oid);
    if (preview.fingerprint !== options.fingerprint) throw new Error('The note changed. Review its latest version first.');
    const selected = new Set(options.selected || []);
    if (!selected.size || [...selected].some(id => !preview.blocks.some(b => b.id === id && !b.shared))) throw new Error('Select changes to restore.');
    const content = renderRecovery(preview.blocks, selected);
    await this.protect(); await this.backupFile(options.path);
    if (await this.fingerprint(options.path) !== options.fingerprint) throw new Error('The note changed. Review it again.');
    const file = await this.safePath(options.path);
    await this.fs.mkdir(this.path.dirname(file), { recursive: true });
    await this.fs.writeFile(file, content);
    await this.git('add', '--', options.path);
    // An explicit restore authorizes exactly the previewed result, not later edits.
    const oid = await this.git('hash-object', '-w', '--path', options.path, '--', file);
    this.data.incoming = (this.data.incoming || []).filter(x => x.path !== options.path);
    this.data.incoming.push({ path: options.path, expected: oid, previous: null });
    this.data.approved = null; this.data.approval = null; await this.save();
  }
  async restoreVersion(name, commit, fingerprint) {
    if (this.data.pending || (await this.conflicts()).length) throw new Error('Finish reviewing the current combine before recovering another version.');
    const file = await this.safePath(name);
    if (!fingerprint || await this.fingerprint(name) !== fingerprint) throw new Error('The file changed. Preview its latest version first.');
    const bytes = await this.sourceBytes(name, commit);
    await this.protect(); await this.backupFile(name);
    if (await this.fingerprint(name) !== fingerprint) throw new Error('The file changed. Review it again.');
    await this.fs.mkdir(this.path.dirname(file), { recursive: true });
    await this.fs.writeFile(file, bytes);
    await this.git('add', '--', name);
    const expected = await this.git('hash-object', '-w', '--path', name, '--', file);
    this.data.incoming = (this.data.incoming || []).filter(entry => entry.path !== name);
    this.data.incoming.push({ path: name, expected, previous: null });
    this.data.approved = null; this.data.approval = null;
    await this.save();
  }
  async backupFile(name) {
    const file = await this.safePath(name);
    let bytes;
    try { bytes = await this.fs.readFile(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    const folder = this.path.join(this.directory, 'copies', require('node:crypto').randomUUID());
    await this.fs.mkdir(folder, { recursive: true });
    await this.fs.writeFile(this.path.join(folder, 'content'), bytes);
    await this.fs.writeFile(this.path.join(folder, 'source.json'), JSON.stringify({ path: name, date: Date.now() }));
  }
  async restoreIncoming(fingerprint) {
    const losses = await this.suspiciousLosses();
    if (!losses) return;
    if (!fingerprint || losses.fingerprint !== fingerprint) throw new Error('The files changed. Review them again.');
    await this.protect();
    const plans = [];
    for (const name of losses.paths) {
      const file = await this.safePath(name);
      const entry = (this.data.incoming || []).find(x => x.path === name);
      const blob = entry?.expected || await this.git('rev-parse', `HEAD:${name}`);
      const bytes = await this.gitBytes('cat-file', 'blob', blob);
      let current = null;
      try { current = await this.fs.readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await this.backupFile(name);
      plans.push({ name, file, bytes, current });
    }
    if ((await this.suspiciousLosses())?.fingerprint !== fingerprint) throw new Error('The files changed. Review them again.');
    for (const { name, file, bytes, current } of plans) {
      let now = null;
      try { now = await this.fs.readFile(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      if (current === null ? now !== null : !now || !current.equals(now)) throw new Error('The file changed. Review it again.');
      await this.fs.mkdir(this.path.dirname(file), { recursive: true });
      await this.fs.writeFile(file, bytes);
      await this.git('add', '--', name);
    }
  }
  async replacementPreview(fingerprint) {
    const losses = await this.suspiciousLosses();
    if (!losses || losses.fingerprint !== fingerprint) throw new Error('The files changed. Review them again.');
    const files = [];
    for (const name of losses.paths) {
      const entry = (this.data.incoming || []).find(x => x.path === name);
      const oid = entry?.expected || await this.git('rev-parse', `HEAD:${name}`);
      let current = require('node:buffer').Buffer.alloc(0), deleted = false;
      try { current = await this.fs.readFile(await this.safePath(name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      try { await this.fs.access(await this.safePath(name)); } catch (error) { if (error.code !== 'ENOENT') throw error; deleted = true; }
      const replacement = await this.gitBytes('cat-file', 'blob', oid);
      let blocks = null;
      try { blocks = recoveryBlocks(decodeNote(current), decodeNote(replacement)); } catch { }
      files.push({ path: name, blocks, deleted, currentBytes: current.length, replacementBytes: replacement.length });
    }
    if ((await this.suspiciousLosses())?.fingerprint !== fingerprint) throw new Error('The files changed. Review them again.');
    return { fingerprint, files };
  }
  async mergeProtected(options) {
    if (this.data.pending || (await this.conflicts()).length) throw new Error('Finish the current Git merge first.');
    const preview = await this.replacementPreview(options.fingerprint);
    const entry = preview.files.find(file => file.path === options.path);
    if (!entry?.blocks || !/\.md$/i.test(options.path)) throw new Error('This file cannot be merged as a note.');
    renderProtectedMerge(entry.blocks, options.choices); // Require an explicit choice for every differing passage.
    if (typeof options.content !== 'string' || /^(<<<<<<< |=======\s*$|>>>>>>> )/m.test(options.content)) throw new Error('Review the complete merged note before saving.');
    await this.protect(); await this.backupFile(options.path);
    if ((await this.suspiciousLosses())?.fingerprint !== options.fingerprint) throw new Error('The files changed. Review the latest versions first.');
    const file = await this.safePath(options.path);
    await this.fs.mkdir(this.path.dirname(file), { recursive: true });
    await this.fs.writeFile(file, options.content);
    await this.git('add', '--', options.path);
    this.data.incoming = (this.data.incoming || []).filter(entry => entry.path !== options.path);
    this.data.approved = null; this.data.approval = null; await this.save();
  }
  async combineConflicts(error) {
    const entries = await this.conflicts();
    if (!entries.length) throw error;
    for (const entry of entries) if (entry.merge?.clean) {
      await this.resolve({ path: entry.path, choice: 'merged', fingerprint: entry.fingerprint });
    }
    let remaining = await this.conflicts();
    if (remaining.length) {
      // Never leave Git's conflict markers in a note. Until a choice is made
      // the note shows this computer's text; both versions stay in the index.
      for (const entry of remaining) if (entry.sides['2'] && !entry.sides['2'].binary) await this.git('checkout', '--ours', '--', entry.path);
      remaining = await this.conflicts();
      this.onConflicts?.(remaining);
      throw new Error(`${remaining.length} files need your choice. Both versions are protected.`);
    }
    if (await this.git('diff', '--name-only')) throw new Error('Files changed during the combine. Review them before finishing.');
    await this.git('commit', '--no-edit');
  }
  async conflicts() {
    const records = (await this.gitBytes('ls-files', '-u', '-z')).toString().split('\0').filter(Boolean);
    const grouped = new Map();
    for (const row of records) {
      const match = /^(\d+) ([a-f0-9]+) ([123])\t([\s\S]+)$/.exec(row);
      if (!match) throw new Error('Cannot read conflict details safely.');
      const [, mode, oid, stage, name] = match;
      if (!grouped.has(name)) grouped.set(name, { path: name, sides: {} });
      grouped.get(name).sides[stage] = { oid, mode };
    }
    const result = [];
    for (const entry of grouped.values()) {
      for (const stage of ['1', '2', '3']) {
        if (!entry.sides[stage]) continue;
        const bytes = await this.gitBytes('cat-file', 'blob', entry.sides[stage].oid);
        try { entry.sides[stage].text = decodeNote(bytes); entry.sides[stage].binary = false; }
        catch { entry.sides[stage].text = null; entry.sides[stage].binary = true; }
      }
      const file = await this.safePath(entry.path);
      let working = null;
      try { working = require('node:crypto').createHash('sha256').update(await this.fs.readFile(file)).digest('hex'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      entry.fingerprint = JSON.stringify({ sides: entry.sides, working, head: await this.git('rev-parse', 'HEAD'), pending: this.data.pending });
      if (/\.md$/i.test(entry.path) && ['2', '3'].every(stage => entry.sides[stage] && !entry.sides[stage].binary) &&
        Object.values(entry.sides).every(side => side.mode === '100644' || side.mode === '100755')) {
        try {
          const local = noteLines(entry.sides['2'].text), server = noteLines(entry.sides['3'].text);
          // Both devices created this note. Identical, or one holding all of
          // the other, needs no choice.
          const fuller = containsLines(local, server) ? local : containsLines(server, local) ? server : null;
          entry.merge = entry.sides['1'] && !entry.sides['1'].binary
            ? mergeNote(entry.sides['1'].text, entry.sides['2'].text, entry.sides['3'].text)
            : fuller ? { clean: true, blocks: [{ id: 0, conflict: false, result: fuller }] }
            : { clean: false, blocks: [{ id: 0, conflict: true, base: [], local, server }] };
        } catch { entry.mergeUnavailable = 'This comparison is too large. Compare the full copies and combine them manually.'; }
      } else if (/^\.obsidian\/.*\.json$/i.test(entry.path) && ['2', '3'].every(stage => entry.sides[stage] && !entry.sides[stage].binary) &&
        Object.values(entry.sides).every(side => side.mode === '100644' || side.mode === '100755')) {
        const time = async ref => Number(await this.optional('log', '-1', '--format=%ct', ref)) || 0;
        const combined = mergeSettings(entry.sides['1']?.binary ? null : entry.sides['1']?.text, entry.sides['2'].text, entry.sides['3'].text,
          await time('MERGE_HEAD') >= await time('HEAD'));
        if (combined !== null) entry.merge = { clean: true, blocks: [{ id: 0, conflict: false, result: combined.split('\n') }] };
      }
      result.push(entry);
    }
    return result;
  }
  async resolve({ path: name, choice, fingerprint, content, choices }) {
    const entry = (await this.conflicts()).find(x => x.path === name);
    if (!entry || entry.fingerprint !== fingerprint) throw new Error('This conflict changed. Review the latest versions.');
    if (!['phone', 'server', 'both', 'edited', 'merged'].includes(choice)) throw new Error('Choose a version first.');
    if (choice === 'merged') {
      if (!entry.merge) throw new Error('This file needs manual review.');
      const combined = renderMerge(entry.merge, choices);
      content = content === undefined ? combined : content;
    }
    const file = await this.safePath(name);
    if (Object.values(entry.sides).some(side => side.mode !== '100644' && side.mode !== '100755')) throw new Error('This file type needs review in a Git client.');
    await this.protect(); await this.backupFile(name);
    if ((await this.conflicts()).find(x => x.path === name)?.fingerprint !== fingerprint) throw new Error('This conflict changed. Review the latest versions.');
    if (choice === 'both') {
      if (name.startsWith('.obsidian/') || !entry.sides['2'] || !entry.sides['3']) throw new Error('Choose one active settings version. Both originals remain protected.');
      const parsed = this.path.parse(name);
      const copy = this.path.join(parsed.dir, `${parsed.name} (Server copy ${require('node:crypto').randomUUID().slice(0,8)})${parsed.ext}`);
      const destination = await this.safePath(copy);
      await this.fs.writeFile(destination, await this.gitBytes('cat-file', 'blob', entry.sides['3'].oid), { flag: 'wx' });
      await this.git('add', '--', copy);
    }
    const selected = entry.sides[choice === 'server' ? '3' : '2'];
    if (choice === 'edited' || choice === 'merged' || selected) {
      const bytes = ['edited', 'merged'].includes(choice) ? require('node:buffer').Buffer.from(content, 'utf8') : await this.gitBytes('cat-file', 'blob', selected.oid);
      if (name.endsWith('.json')) { try { JSON.parse(bytes.toString('utf8')); } catch { throw new Error('The chosen settings are not valid JSON. Correct them before saving.'); } }
      await this.fs.mkdir(this.path.dirname(file), { recursive: true }); await this.fs.writeFile(file, bytes);
      await this.git('add', '--', name);
    } else {
      await this.git('rm', '-f', '--', name);
    }
  }
}

// Shows `text` with the words that differ from `before` marked, so the eye
// lands on what changed instead of re-reading the whole passage.
function showWords(container, before, text) {
  const pre = container.createEl('pre', { cls: 'vault-sync-recovery-text' });
  if (!text) { pre.createEl('span', { cls: 'vault-sync-empty', text: '(nothing here)' }); return pre; }
  const tokens = value => value.match(/[\p{L}\p{N}\p{M}]+|\s+|[^\p{L}\p{N}\p{M}\s]/gu) || [];
  const a = tokens(before || ''), b = tokens(text);
  if (before === null || before === undefined || a.length * b.length > 250000) { pre.createEl('span', { text }); return pre; }
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  let i = 0, j = 0, run = '', changed = false;
  const flush = () => { if (run) pre.createEl(changed ? 'mark' : 'span', { text: run }); run = ''; };
  const push = (token, isChanged) => { if (isChanged !== changed) { flush(); changed = isChanged; } run += token; };
  while (j < b.length) {
    if (i < a.length && a[i] === b[j]) { push(b[j], false); i++; j++; }
    else if (i < a.length && table[i + 1][j] >= table[i][j + 1]) i++;
    else { push(b[j], !/^\s+$/.test(b[j]) || changed); j++; }
  }
  flush();
  return pre;
}

// One conflict, one card, one tap. Safe combinations never reach this screen
// (SYNC_RULES.md); what is left is a real choice between two wordings.
class ConflictReviewModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  onOpen() { this.plugin.reviewOpen = true; this.setTitle('Your choice is needed'); void this.render(); }
  onClose() { this.closed = true; this.plugin.reviewOpen = false; }
  async render() {
    const ok = await this.plugin.runAction('review');
    if (this.closed) return;
    const root = this.contentEl; root.empty(); root.addClass('vault-sync-clear-review');
    if (!ok) { root.createEl('p', { text: this.plugin.feedback }); return; }
    const entries = this.plugin.review || [];
    if (!entries.length) {
      // The last choice finishes the job; there is no extra confirm step.
      root.createEl('p', { text: 'All set. Saving and uploading now…', attr: { role: 'status' } });
      this.close(); await this.plugin.syncVault();
      return;
    }
    const entry = entries[0];
    const settings = entry.path.startsWith('.obsidian/');
    const name = settings ? 'Obsidian settings' : entry.path.split('/').pop().replace(/\.md$/i, '');
    root.createEl('p', { cls: 'vault-sync-count', text: entries.length === 1 ? 'Nothing is lost. Both versions are saved.' : `Nothing is lost. Both versions are saved. ${entries.length} files need a choice; this is the first.` });
    const card = root.createDiv({ cls: 'vault-git-sync-review' });
    card.createEl('h3', { text: name });
    card.createEl('p', { cls: 'vault-sync-path', text: entry.path });
    const choose = async (choice, content, choices) => {
      if (this.busy) return; this.busy = true;
      const done = await this.plugin.runAction('resolve', { path: entry.path, fingerprint: entry.fingerprint, choice, content, choices });
      this.busy = false;
      if (done) await this.render(); else new Notice(this.plugin.feedback, 15000);
    };
    const unresolved = entry.merge ? entry.merge.blocks.filter(block => block.conflict) : [];
    if (unresolved.length) {
      card.createEl('p', { cls: 'vault-sync-what', text: unresolved.length === 1
        ? 'This computer and your other device both changed the same lines. Everything else in the note is already combined.'
        : `This computer and your other device both changed the same lines in ${unresolved.length} places. Everything else in the note is already combined.` });
      const choices = {};
      unresolved.forEach((block, index) => {
        const section = card.createDiv({ cls: 'vault-sync-choice' });
        if (unresolved.length > 1) section.createEl('h4', { text: `Place ${index + 1} of ${unresolved.length}` });
        const before = block.base.length ? block.base.join('\n') : null;
        const grid = section.createDiv({ cls: 'vault-sync-compare vault-sync-compare-3' });
        for (const [side, title] of [['base', 'Before'], ['local', 'This computer'], ['server', 'Other device']]) {
          const pane = grid.createDiv({ cls: `vault-sync-pane vault-sync-pane-${side}` }); pane.createEl('h4', { text: title });
          showWords(pane, side === 'base' ? null : before, block[side].join('\n'));
        }
        const picked = section.createEl('p', { cls: 'vault-sync-picked', text: '', attr: { role: 'status', 'aria-live': 'polite' } });
        const row = new Setting(section);
        for (const [side, label] of [['local', 'Keep this computer’s'], ['server', 'Keep other device’s'], ['both', 'Keep both']]) {
          row.addButton(b => b.setButtonText(label).onClick(async () => {
            choices[block.id] = side; picked.textContent = `Chosen: ${label}`;
            if (unresolved.every(item => choices[item.id])) await choose('merged', undefined, choices);
          }));
        }
      });
    } else {
      const local = entry.sides['2'], server = entry.sides['3'];
      card.createEl('p', { cls: 'vault-sync-what', text: !local ? 'You deleted this file on this computer. Your other device edited it.'
        : !server ? 'Your other device deleted this file. You edited it on this computer.'
        : local.binary || server.binary ? 'This attachment changed on both this computer and your other device.'
        : 'This file changed on both this computer and your other device, and the two versions cannot be combined line by line.' });
      if (local && server && !local.binary && !server.binary) {
        const read = card.createEl('details'); read.createEl('summary', { text: 'Read both versions' });
        const grid = read.createDiv({ cls: 'vault-sync-compare' });
        for (const [side, title, other] of [[local, 'This computer', server], [server, 'Other device', local]]) {
          const pane = grid.createDiv({ cls: 'vault-sync-pane' }); pane.createEl('h4', { text: title }); showWords(pane, other.text, side.text);
        }
      }
      const row = new Setting(card);
      row.addButton(b => b.setButtonText(local ? 'Keep this computer’s' : 'Keep it deleted').onClick(() => choose('phone')));
      row.addButton(b => b.setButtonText(server ? 'Keep other device’s' : 'Delete it here too').onClick(() => choose('server')));
      if (local && server && !settings) row.addButton(b => b.setButtonText('Keep both').onClick(() => choose('both')));
      if (local && server && !settings) card.createEl('p', { cls: 'vault-sync-path', text: 'Keep both saves the other device’s version beside this one as a second file.' });
    }
    if (!entry.sides['2']?.binary && !entry.sides['3']?.binary && (entry.sides['2'] || entry.sides['3'])) {
      const editor = card.createEl('details'); editor.createEl('summary', { text: 'Write the result myself' });
      const input = editor.createEl('textarea', { cls: 'vault-git-sync-result', attr: { 'aria-label': 'Result to save' } });
      input.value = unresolved.length ? renderMerge(entry.merge, Object.fromEntries(unresolved.map(block => [block.id, 'local']))) : (entry.sides['2']?.text ?? entry.sides['3']?.text ?? '');
      new Setting(editor).setDesc('Starts from this computer’s version. What you see here is exactly what is saved.')
        .addButton(b => b.setButtonText('Save what I wrote').onClick(() => choose('edited', input.value)));
    }
    new Setting(root).addButton(b => b.setButtonText('Decide later — nothing changes').onClick(() => this.close()));
  }
}

// This is a comparison with a protected saved copy, not necessarily the latest server.
function showChangedPassage(container, current, saved) {
  let prefix = 0, suffix = 0;
  while (prefix < current.length && prefix < saved.length && current[prefix] === saved[prefix]) prefix++;
  while (suffix < current.length - prefix && suffix < saved.length - prefix && current[current.length - 1 - suffix] === saved[saved.length - 1 - suffix]) suffix++;
  if (current.length > saved.length && prefix + suffix === saved.length) container.createEl('p', { text: 'Your current version adds text here. The saved wording is still present.' });
  const grid = container.createDiv({ cls: 'vault-sync-compare' });
  for (const [text, title, kind] of [[saved, 'From your other device', 'saved'], [current, 'On this computer now', 'current']]) {
    const pane = grid.createDiv(); pane.createEl('h4', { text: title });
    const pre = pane.createEl('pre', { cls: 'vault-sync-recovery-text' });
    if (!text) { pre.createEl('span', { text: '(No text in this version)' }); continue; }
    pre.createEl('span', { text: text.slice(0, prefix) });
    pre.createEl('mark', { cls: `vault-sync-change-${kind}`, text: text.slice(prefix, text.length - suffix) });
    pre.createEl('span', { text: suffix ? text.slice(-suffix) : '' });
  }
}
function renderProtectedMerge(blocks, choices = {}) {
  return blocks.flatMap(block => {
    if (block.shared) return block.current;
    const choice = choices[block.id];
    if (!['current', 'historical', 'both'].includes(choice)) throw new Error('Choose what to keep in every changed passage.');
    return choice === 'both' ? [...block.current, ...block.historical] : block[choice];
  }).join('\n');
}
class DeletionReviewModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; this.losses = plugin.attention; }
  onOpen() { this.plugin.reviewOpen = true; this.setTitle('Check this before it is saved'); void this.render(); }
  onClose() { this.closed = true; this.plugin.reviewOpen = false; }
  async render() {
    const root = this.contentEl; root.empty(); root.addClass('vault-sync-clear-review');
    root.createEl('p', { text: 'Loading both versions…', attr: { role: 'status' } });
    const ok = await this.plugin.runAction('replacement-preview', { fingerprint: this.losses.fingerprint });
    if (this.closed) return;
    root.empty();
    if (!ok) {
      root.createEl('p', { text: 'The files changed while this review was open. Close this window and sync again to see the latest versions.' });
      new Setting(root).addButton(b => b.setButtonText('Close without changing anything').onClick(() => this.close()));
      return;
    }
    const files = this.plugin.replacementPreview.files;
    root.createEl('h3', { text: 'Nothing is lost. Saving is paused until you choose.' });
    root.createEl('p', { text: files.length === 1 ? 'This file looks like an older version came back, or most of it was removed. If you meant that, keep it. If not, bring back the version from your other device.' : `${files.length} files look like older versions came back, or lost most of their text. If you meant that, keep them. If not, bring back the versions from your other device.` });
    for (const detail of this.losses.details || []) if (detail.reason) root.createEl('p', { cls: 'vault-sync-what', text: `${detail.path.split('/').pop()}: ${detail.reason}.` });
    for (const file of files) {
      const card = root.createDiv({ cls: 'vault-git-sync-review' });
      card.createEl('h3', { text: file.path.split('/').pop() });
      const location = card.createEl('details'); location.createEl('summary', { text: 'File location' }); location.createEl('p', { text: file.path });
      if (file.deleted) card.createEl('p', { text: 'This file is deleted on this computer. Keeping the current version will also delete it on your other devices after sync.' });
      if (file.blocks) {
        const changed = file.blocks.filter(block => !block.shared);
        if (!changed.length) card.createEl('p', { text: 'The note text matches the saved copy. Git’s staged version may differ; keeping current uses the note shown here.' });
        changed.forEach((block, index) => {
          card.createEl('h4', { text: `Changed passage ${index + 1} of ${changed.length}` });
          showChangedPassage(card, block.current.join('\n'), block.historical.join('\n'));
        });
        const full = card.createEl('details'); full.createEl('summary', { text: 'Read both complete versions' });
        showChangedPassage(full, file.blocks.flatMap(b => b.current).join('\n'), file.blocks.flatMap(b => b.historical).join('\n'));
        if (/\.md$/i.test(file.path)) new Setting(card).setDesc('Choose passages from either copy, then read the complete result before saving.')
          .addButton(b => b.setButtonText('Merge versions…').onClick(() => { this.close(); new ProtectedMergeModal(this.app, this.plugin, this.losses.fingerprint, file).open(); }));
      } else card.createEl('p', { text: `A text comparison is unavailable for this file. Saved copy: ${file.replacementBytes} bytes. Current copy: ${file.currentBytes} bytes. Close this review to inspect it in its own app before choosing.` });
    }
    const deleted = files.some(file => file.deleted);
            new Setting(root).addButton(b => b.setButtonText('Keep what’s on this computer').setCta().onClick(async () => {
      if (this.busy) return; this.busy = true; b.setDisabled(true);
      const saved = await this.plugin.runAction('approve-deletions', { fingerprint: this.losses.fingerprint });
      if (saved) { this.close(); await this.plugin.syncVault(); }
      else { this.busy = false; b.setDisabled(false); new Notice(this.plugin.feedback, 15000); }
    })).addButton(b => b.setButtonText('Bring back the other device’s version…').onClick(() => { this.close(); this.plugin.openReplacementReview(this.losses.fingerprint); }))
      .addButton(b => b.setButtonText('Decide later — nothing changes').onClick(() => this.close()));
    root.createEl('p', { cls: 'vault-sync-path', text: deleted ? 'Keeping saves the current files and deletions and syncs them. Bringing back shows a preview first.' : 'Keeping saves the text on this computer and syncs it. Bringing back shows a preview first.' });
  }
}
class ProtectedMergeModal extends Modal {
  constructor(app, plugin, fingerprint, file) { super(app); Object.assign(this, { plugin, fingerprint, file }); }
  onOpen() {
    this.plugin.reviewOpen = true; this.setTitle('Merge this note');
    const root = this.contentEl; root.addClass('vault-sync-clear-review');
    root.createEl('h3', { text: this.file.path.split('/').pop() });
    root.createEl('p', { text: '1. Choose what to keep in each changed passage. 2. Read the final note. 3. Save and sync when it looks right.' });
    const choices = {}; const changed = this.file.blocks.filter(b => !b.shared);
    const progress = root.createEl('p', { attr: { role: 'status', 'aria-live': 'polite' } });
    let input, save;
    const update = () => {
      const remaining = changed.filter(b => !choices[b.id]).length;
      progress.textContent = remaining ? `${remaining} ${remaining === 1 ? 'passage needs' : 'passages need'} a choice. Nothing has been saved.` : 'Ready to review. The full note below is exactly what will be saved.';
      input.value = renderProtectedMerge(this.file.blocks, Object.fromEntries(changed.map(b => [b.id, choices[b.id] || 'current'])));
      input.disabled = remaining > 0; save.setDisabled(remaining > 0);
    };
    for (const [index, block] of changed.entries()) {
      const card = root.createDiv({ cls: 'vault-git-sync-review' });
      card.createEl('h3', { text: `Passage ${index + 1} of ${changed.length}` });
      showChangedPassage(card, block.current.join('\n'), block.historical.join('\n'));
      const selected = card.createEl('p', { text: 'No choice yet', attr: { role: 'status' } });
      const row = new Setting(card);
      for (const [choice, label] of [['current', 'Keep my current text'], ['historical', 'Use saved text instead'], ['both', 'Keep both passages']]) row.addButton(b => b.setButtonText(label).onClick(() => { choices[block.id] = choice; selected.textContent = `Selected: ${label}`; update(); }));
    }
    root.createEl('h3', { text: 'Final note · this is what will be saved' });
    root.createEl('p', { text: 'You can edit this preview after choosing every passage. Changing a passage choice rebuilds the preview and replaces any typing here.' });
    input = root.createEl('textarea', { cls: 'vault-git-sync-result', attr: { 'aria-label': 'Final note to save' } });
    new Setting(root).addButton(b => { save = b; b.setButtonText('Save this merged note and sync').setCta().onClick(async () => {
      if (this.busy) return; this.busy = true; b.setDisabled(true);
      const ok = await this.plugin.runAction('merge-protected', { path: this.file.path, fingerprint: this.fingerprint, choices, content: input.value });
      if (ok) { this.close(); await this.plugin.syncVault(); }
      else { this.busy = false; b.setDisabled(false); new Notice(this.plugin.feedback, 15000); }
    }); }).addButton(b => b.setButtonText('Cancel — keep everything unchanged').onClick(() => this.close()));
    update();
  }
  onClose() { this.plugin.reviewOpen = false; }
}

class IncomingReplacementModal extends Modal {
  constructor(app, plugin, fingerprint) { super(app); this.plugin = plugin; this.fingerprint = fingerprint; }
  onOpen() { this.plugin.reviewOpen = true; this.setTitle('Confirm whole-file replacement'); void this.render(); }
  onClose() { this.closed = true; this.plugin.reviewOpen = false; }
  async render() {
    const ok = await this.plugin.runAction('replacement-preview', { fingerprint: this.fingerprint });
    if (this.closed) return;
    if (!ok) { this.contentEl.createEl('p', { text: this.plugin.feedback }); return; }
    this.contentEl.createEl('p', { text: 'This replaces entire files, including newer checkboxes and journal entries shown below. Use selective recovery to keep newer work. Current files are backed up first; nothing uploads.' });
    for (const file of this.plugin.replacementPreview.files) {
      this.contentEl.createEl('h3', { text: file.path });
      if (!file.blocks) this.contentEl.createEl('p', { text: `Inline comparison unavailable. Replaces ${file.currentBytes} current bytes with ${file.replacementBytes} protected bytes.` });
      else for (const block of file.blocks.filter(b => !b.shared)) {
        this.contentEl.createEl('p', { text: 'Current text that will be replaced' });
        this.contentEl.createEl('pre', { cls: 'vault-sync-recovery-text', text: block.current.join('\n') || '(No text)' });
        this.contentEl.createEl('p', { text: 'Replacement text' });
        this.contentEl.createEl('pre', { cls: 'vault-sync-recovery-text', text: block.historical.join('\n') || '(No text)' });
      }
      if (/\.md$/i.test(file.path)) new Setting(this.contentEl).addButton(b => b.setButtonText('Choose text to restore').onClick(() => { this.close(); new HistoryRecoveryModal(this.app, this.plugin, file.path).open(); }));
    }
    new Setting(this.contentEl).addButton(b => b.setButtonText('Cancel').onClick(() => this.close()))
      .addButton(b => b.setButtonText('Replace whole files').onClick(async () => {
        if (await this.plugin.runAction('recover', { fingerprint: this.fingerprint, confirmReplacement: true })) this.close();
        else new Notice(this.plugin.feedback, 15000);
      }));
  }
}

class SyncHomeModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  onOpen() {
    this.setTitle('Your vault');
    const status = this.contentEl.createEl('p', { text: this.plugin.feedback, attr: { role: 'status', 'aria-live': 'polite' } });
    const times = this.contentEl.createEl('p', { text: savedTimes(this.plugin) });
    const update = () => { status.textContent = this.plugin.feedback; times.textContent = savedTimes(this.plugin); };
    this.plugin.listeners.add(update); this.cleanup = () => this.plugin.listeners.delete(update);
    new Setting(this.contentEl).addButton(b => b.setButtonText((this.plugin.attention || this.plugin.outcome?.kind === 'attention') ? 'Review and continue' : 'Sync now').setCta().onClick(async () => { this.close(); await this.plugin.syncVault(); }));
    new Setting(this.contentEl).addButton(b => b.setButtonText('Recover previous work').onClick(() => { this.close(); new HistoryRecoveryModal(this.app, this.plugin).open(); }));
    const details = this.contentEl.createEl('details'); details.createEl('summary', { text: 'Git tools and details' });
    this.toolsCleanup = renderTools(details.createDiv(), this.plugin);
  }
  onClose() { this.cleanup?.(); this.toolsCleanup?.(); }
}

class HistoryRecoveryModal extends Modal {
  constructor(app, plugin, note) { super(app); this.plugin = plugin; this.note = note; }
  onOpen() { this.setTitle('Recover previous work'); void (this.note ? this.noteHistory(this.note) : this.notes()); }
  onClose() { this.closed = true; }
  failure(retry) {
    this.contentEl.empty(); this.contentEl.createEl('p', { text: this.plugin.feedback });
    new Setting(this.contentEl).addButton(b => b.setButtonText('Try again').onClick(retry));
  }
  async notes() {
    if (!await this.plugin.runAction('recovery-notes') || this.closed) { if (!this.closed) this.failure(() => this.notes()); return; }
    this.contentEl.empty();
    this.contentEl.createEl('p', { text: 'Find a note, compare its versions, and restore only the text you need. Obsidian File Recovery snapshots are available separately in Settings → File recovery.' });
    let list;
    const show = query => {
      list.empty();
      for (const name of this.plugin.recoveryNotes.filter(x => x.toLowerCase().includes(query.toLowerCase())).slice(0, 100)) new Setting(list).setName(name).addButton(b => b.setButtonText('Versions').onClick(() => this.noteHistory(name)));
    };
    new Setting(this.contentEl).setName('Search notes (including deleted notes)').addText(input => input.onChange(show));
    new Setting(this.contentEl).addButton(b => b.setButtonText('Browse checkpoints').onClick(() => this.render()));
    list = this.contentEl.createDiv();
    show('');
  }
  async noteHistory(name, skip = 0) {
    if (!await this.plugin.runAction('note-history', { path: name, skip }) || this.closed) { if (!this.closed) this.failure(() => this.noteHistory(name, skip)); return; }
    this.contentEl.empty(); this.contentEl.createEl('h3', { text: name });
    new Setting(this.contentEl).addButton(b => b.setButtonText('Find another note').onClick(() => this.notes()));
    for (const entry of this.plugin.history) new Setting(this.contentEl).setName(new Date(entry.date).toLocaleString()).setDesc(entry.subject)
      .addButton(b => b.setButtonText('Compare').onClick(() => this.preview(name, entry.oid)))
      .addButton(b => b.setButtonText('Whole-file recovery').onClick(() => this.wholeFile(name, entry.oid)));
    if (this.plugin.historyHasMore) new Setting(this.contentEl).addButton(b => b.setButtonText('Earlier versions').onClick(() => this.noteHistory(name, skip + 50)));
  }
  async wholeFile(name, oid) {
    if (!await this.plugin.runAction('whole-preview', { path: name, oid }) || this.closed) { if (!this.closed) this.failure(() => this.wholeFile(name, oid)); return; }
    const preview = this.plugin.recoveryPreview;
    this.contentEl.empty();
    this.contentEl.createEl('p', { text: 'Replace the entire note with this version? Newer text and checkboxes will be replaced. The current file is backed up first; nothing uploads.' });
    if (!preview.blocks) this.contentEl.createEl('p', { text: `Inline comparison unavailable. Replaces ${preview.currentBytes} current bytes with ${preview.replacementBytes} historical bytes.` });
    else for (const block of preview.blocks.filter(b => !b.shared)) {
      this.contentEl.createEl('pre', { cls: 'vault-sync-recovery-text', text: 'Current text that will be replaced:\n' + block.current.join('\n') + '\nReplacement text:\n' + block.historical.join('\n') });
    }
    new Setting(this.contentEl).addButton(b => b.setButtonText('Cancel').onClick(() => this.noteHistory(name)))
      .addButton(b => b.setButtonText('Replace whole file').onClick(async () => {
        if (await this.plugin.runAction('restore-history', { path: name, oid, fingerprint: preview.fingerprint, confirmReplacement: true })) this.close();
        else new Notice(this.plugin.feedback, 15000);
      }));
  }
  async preview(name, oid) {
    if (!await this.plugin.runAction('recovery-preview', { path: name, oid }) || this.closed) { if (!this.closed) this.failure(() => this.noteHistory(name)); return; }
    const preview = this.plugin.recoveryPreview; const selected = new Set();
    this.contentEl.empty(); this.contentEl.createEl('h3', { text: name });
    this.contentEl.createEl('p', { text: 'Choose changes to restore. Unselected changes keep the current text.' });
    const result = this.contentEl.createEl('pre', { cls: 'vault-sync-recovery-text', text: renderRecovery(preview.blocks, selected) });
    for (const block of preview.blocks.filter(b => !b.shared)) {
      this.contentEl.createEl('pre', { cls: 'vault-sync-recovery-text', text: 'Current:\n' + block.current.join('\n') + '\nHistorical:\n' + block.historical.join('\n') });
      new Setting(this.contentEl).addToggle(t => t.setValue(false).onChange(value => { if (value) selected.add(block.id); else selected.delete(block.id); result.textContent = renderRecovery(preview.blocks, selected); }));
    }
    new Setting(this.contentEl).addButton(b => b.setButtonText('Restore selected changes').onClick(async () => {
      if (await this.plugin.runAction('restore-selection', { path: name, oid, fingerprint: preview.fingerprint, selected: [...selected] })) this.close();
    })).addButton(b => b.setButtonText('Back').onClick(() => this.noteHistory(name)));
  }
  async render(commit) {
    const ok = await this.plugin.runAction(commit ? 'history-files' : 'history', commit ? { oid: commit.oid } : {});
    if (this.closed) return;
    this.contentEl.empty();
    if (!ok) { this.contentEl.createEl('p', { text: this.plugin.feedback }); return; }
    this.contentEl.createEl('p', { text: 'Choose a checkpoint and a file. Its current contents will be protected before restoring. Nothing uploads until you sync.' });
    if (!commit) {
      for (const entry of this.plugin.history || []) new Setting(this.contentEl).setName(new Date(entry.date).toLocaleString()).setDesc(entry.subject)
        .addButton(b => b.setButtonText('View files').onClick(() => this.render(entry)));
    } else {
      new Setting(this.contentEl).addButton(b => b.setButtonText('Back to checkpoints').onClick(() => this.render()));
      for (const file of this.plugin.historyFiles || []) new Setting(this.contentEl).setName(file.path).setDesc(file.deleted ? 'Restore the version before deletion.' : 'Restore the version saved in this checkpoint.')
        .addButton(b => b.setButtonText('Preview restoration').onClick(() => this.wholeFile(file.path, file.oid)));
    }
  }
}

module.exports.SyncEngine = SyncEngine;
module.exports.SyncSafety = SyncSafety;

if (HEADLESS) {
  const fs = require('node:fs/promises');
  const path = require('node:path');
  const { execFile } = require('node:child_process');
  const runFile = require('node:util').promisify(execFile);
  const args = process.argv.slice(2);
  const watch = args[0] === '--watch';
  if (!['--sync', '--watch'].includes(args[0]) || !args[1]) {
    process.stderr.write('Usage: node main.js --sync|--watch /path/to/vault\n'); process.exitCode = 2;
  } else {
    const engine = new SyncEngine();
    const vault = path.resolve(args[1]);
    engine.app = { vault: { adapter: { getBasePath: () => vault } } };
    let stopped = false;
    process.on('SIGTERM', () => { stopped = true; });
    process.on('SIGINT', () => { stopped = true; });
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    (async () => {
      let lastRun = 0; let lastKey = ''; let changedAt = 0; let retryAt = 0; let failures = 0;
      do {
        const now = Date.now();
        const raw = (await runFile('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { cwd: vault, maxBuffer: 8 * 1024 * 1024 })).stdout;
        // Use metadata to debounce without reading large attachment diffs every five seconds.
        const diff = (await runFile('git', ['diff', '--raw', 'HEAD'], { cwd: vault, maxBuffer: 16 * 1024 * 1024 })).stdout;
        const keyHash = require('node:crypto').createHash('sha256').update(raw).update(diff);
        for (const record of raw.split('\0')) {
          if (record.length < 4) continue;
          try { const info = await fs.stat(path.join(vault, record.slice(3))); keyHash.update(String(info.mtimeMs) + ':' + info.size); } catch { }
        }
        const key = keyHash.digest('hex');
        if (key !== lastKey) { lastKey = key; changedAt = now; }
        if (engine.attention && key !== engine.attentionKey) { engine.attention = null; retryAt = 0; lastRun = 0; }
        engine.attentionKey = key;
        const ready = !lastRun || (!engine.attention && now >= retryAt && ((raw && now - changedAt >= 45000) || (failures > 0 && now >= retryAt) || now - lastRun >= 600000));
        if (ready) {
          const ok = await engine.runAction('sync', { automatic: true }); lastRun = Date.now();
          failures = ok ? 0 : failures + 1;
          retryAt = lastRun + (failures ? [60000, 300000, 900000][Math.min(failures - 1, 2)] : 0);
          process.stdout.write(JSON.stringify({ kind: engine.outcome?.kind, date: lastRun }) + '\n');
          if (!watch) process.exitCode = ok ? 0 : 1;
        }
        if (watch && engine.statusFile) await fs.writeFile(engine.statusFile + '.helper', JSON.stringify({ pid: process.pid, date: Date.now() }));
        if (!watch || stopped) break;
        await wait(5000);
      } while (!stopped);
    })().catch(() => { process.stderr.write('Background sync needs attention. Open Obsidian to review.\n'); process.exitCode = 1; });
  }
}

module.exports.recoveryBlocks = recoveryBlocks;
module.exports.renderRecovery = renderRecovery;
module.exports.noteLoss = noteLoss;
module.exports.mergeSettings = mergeSettings;
module.exports.mergeNote = mergeNote;
module.exports.renderMerge = renderMerge;

module.exports.renderProtectedMerge = renderProtectedMerge;
