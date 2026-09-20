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
    if (this.app.workspace && this.attention?.kind === 'conflicts' && !options.automatic && !this.reviewOpen) new ConflictReviewModal(this.app, this).open();
    if (this.app.workspace && this.attention?.kind === 'deletions' && !options.automatic && !this.reviewOpen) new DeletionReviewModal(this.app, this).open();
    return result;
  }
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
            seen = record.date; this.outcome = { kind: record.kind };
            const label = { complete: 'All saved — you’re all set.', local: 'Saved here. Waiting to upload.', pending: 'New edits are waiting to sync.', attention: 'Some files need your review.', failed: 'Sync needs attention.' };
            this.report(label[record.kind] || 'Checking your vault…');
          }
        } catch { }
      } else if (!this.attention && Date.now() >= retryAt && ((this.lastEdit && Date.now() - this.lastEdit >= 45000) || (failures > 0 && Date.now() >= retryAt) || Date.now() - lastRemote >= 600000)) {
        const started = Date.now(); const ok = await this.runAction('sync', { automatic: true }); lastRemote = Date.now();
        if (ok && this.lastEdit <= started) this.lastEdit = 0;
        failures = ok ? 0 : failures + 1;
        retryAt = Date.now() + (failures ? [60000, 300000, 900000][Math.min(failures - 1, 2)] : 0);
      }
      if (this.statusItem) { this.statusItem.textContent = ({ complete: 'All saved', local: 'Saved here · waiting to upload', pending: 'Edits waiting to sync', attention: 'Review needed', syncing: 'Saving…', failed: 'Sync needs attention' })[this.outcome?.kind] || 'Checking save status'; this.statusItem.setAttribute('aria-label', this.feedback + ' Open sync status'); }
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
    if (!['sync', 'commit', 'pull', 'merge', 'push', 'status', 'finish', 'force', 'inspect', 'prepare', 'connect', 'upload', 'review', 'resolve', 'recover', 'approve-deletions', 'history', 'history-files', 'restore-history'].includes(action)) return false;
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
      const git = async (...args) => (await runFile(executable, args, {
        cwd: vaultPath, env, timeout: 600000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
      })).stdout.trim();
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
      const safety = new SyncSafety({ fs, path, git, gitBytes, vaultPath, gitDir });
      await safety.load();
      const statusFile = path.join(state, require('node:crypto').createHash('sha256').update(vaultPath).digest('hex') + '.json');
      this.statusFile = statusFile;
      publishState = async () => {
        if (['history', 'history-files'].includes(action)) return;
        // Persist only coarse state, never errors, paths or document contents.
        const data = { kind: this.outcome?.kind || 'idle', localSaved, date: Date.now(), attention: this.attention?.kind || null, count: this.attention?.paths?.length || 0 };
        await fs.writeFile(statusFile + '.tmp', JSON.stringify(data));
        await fs.rename(statusFile + '.tmp', statusFile);
      };
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
        await safety.restoreVersion(options.path, options.oid);
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
      if (action === 'recover') {
        await safety.restoreIncoming();
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
          throw new Error(`${losses.paths.length} unexpected file changes need your review. Previous versions are protected. Nothing was uploaded.`);
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
        if (await git('diff', '--cached', '--name-only')) {
          await git('commit', '-m', `vault sync: ${new Date().toISOString()}`);
        }
        if (await git('status', '--porcelain')) {
          throw new Error('The vault changed while saving. Your checkpoint is safe; run sync again.');
        }
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
        try { await git(...args, mergeHead); await git('lfs', 'pull', 'origin'); await safety.finishIntegration(); }
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
          const entries = await safety.conflicts();
          if (entries.length) {
            this.attention = { kind: 'conflicts', paths: entries.map(x => x.path) };
            this.outcome = { kind: 'attention' };
            throw new Error(`${entries.length} files need your choice. Both versions are protected.`);
          }
          throw error;
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
    preview.createEl('pre', { text: SETUP_IGNORES.join('\n') });
    preview.createEl('pre', { text: `Existing .gitignore:\n${state?.ignores || '(none)'}\n\nExisting .gitattributes:\n${state?.attributes || '(none)'}\n\nCurrently ignored files (existing repository):\n${state?.excluded || '(none detected; check again after preparation)'}` });
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
      container.createEl('pre', { text: this.reviewed.text });
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
    const names = (await this.gitBytes('diff', '--name-only', '-z', before, after)).toString().split('\0').filter(Boolean);
    if (names.length) this.data.incoming = [];
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
    const raw = (await this.gitBytes('status', '--porcelain=v1', '-z')).toString();
    const entries = raw.split('\0'); const deleted = [];
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]; if (!e) continue;
      if (/[RC]/.test(e.slice(0, 2))) { i++; continue; }
      if (e.slice(0, 2).includes('D')) deleted.push(e.slice(3));
    }
    const total = (await this.gitBytes('ls-files', '-z')).toString().split('\0').filter(Boolean).length;
    const paths = new Set(deleted.length >= 20 || (deleted.length >= 5 && deleted.length / Math.max(total, 1) >= .2) ? deleted : []);
    for (const entry of this.data.incoming || []) {
      // An explicitly committed replacement/deletion supersedes this receipt.
      if (await this.optional('rev-parse', `HEAD:${entry.path}`) !== entry.expected) continue;
      const file = await this.safePath(entry.path);
      try {
        await this.fs.access(file);
        const oid = await this.git('hash-object', '--path', entry.path, '--', file);
        if (entry.previous && entry.previous !== entry.expected && oid === entry.previous) paths.add(entry.path);
      } catch (error) { if (error.code === 'ENOENT') paths.add(entry.path); else throw error; }
    }
    if (!paths.size) return null;
    const list = [...paths].sort();
    const fingerprintHash = require('node:crypto').createHash('sha256').update(await this.git('rev-parse', 'HEAD')).update(raw).update(JSON.stringify(list));
    for (const name of list) {
      try { fingerprintHash.update(await this.fs.readFile(await this.safePath(name))); }
      catch (error) { if (error.code !== 'ENOENT') throw error; fingerprintHash.update('missing'); }
    }
    const fingerprint = fingerprintHash.digest('hex');
    if (this.data.approved === fingerprint) return null;
    return { paths: list, fingerprint };
  }
  async approveLosses(fingerprint) {
    const losses = await this.suspiciousLosses();
    if (!losses || losses.fingerprint !== fingerprint) throw new Error('The files changed. Review the latest changes first.');
    await this.protect(); this.data.approved = fingerprint; await this.save();
  }
  async restoreVersion(name, commit) {
    if (!/^[a-f0-9]{40}$/.test(commit || '')) throw new Error('Choose a saved checkpoint.');
    if (this.data.pending || (await this.conflicts()).length) throw new Error('Finish reviewing the current combine before recovering another version.');
    const file = await this.safePath(name);
    const bytes = await this.gitBytes('show', `${commit}:${name}`);
    await this.protect(); await this.backupFile(name);
    await this.fs.mkdir(this.path.dirname(file), { recursive: true });
    await this.fs.writeFile(file, bytes);
    this.data.incoming = (this.data.incoming || []).filter(entry => entry.path !== name);
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
  async restoreIncoming() {
    const losses = await this.suspiciousLosses();
    if (!losses) return;
    await this.protect();
    for (const name of losses.paths) {
      const file = await this.safePath(name);
      const entry = (this.data.incoming || []).find(x => x.path === name);
      const blob = entry?.expected || await this.git('rev-parse', `HEAD:${name}`);
      const bytes = await this.gitBytes('cat-file', 'blob', blob);
      await this.backupFile(name);
      await this.fs.mkdir(this.path.dirname(file), { recursive: true });
      await this.fs.writeFile(file, bytes);
      await this.git('add', '--', name);
    }
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
        entry.sides[stage].binary = bytes.includes(0);
        entry.sides[stage].text = bytes.includes(0) ? null : bytes.toString('utf8');
      }
      const file = await this.safePath(entry.path);
      let working = null;
      try { working = require('node:crypto').createHash('sha256').update(await this.fs.readFile(file)).digest('hex'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      entry.fingerprint = JSON.stringify({ sides: entry.sides, working });
      result.push(entry);
    }
    return result;
  }
  async resolve({ path: name, choice, fingerprint, content }) {
    const entry = (await this.conflicts()).find(x => x.path === name);
    if (!entry || entry.fingerprint !== fingerprint) throw new Error('This conflict changed. Review the latest versions.');
    if (!['phone', 'server', 'both', 'edited'].includes(choice)) throw new Error('Choose a version first.');
    const file = await this.safePath(name);
    if (Object.values(entry.sides).some(side => side.mode !== '100644' && side.mode !== '100755')) throw new Error('This file type needs review in a Git client.');
    await this.protect(); await this.backupFile(name);
    if (choice === 'both') {
      if (name.startsWith('.obsidian/') || !entry.sides['2'] || !entry.sides['3']) throw new Error('Choose one active settings version. Both originals remain protected.');
      const parsed = this.path.parse(name);
      const copy = this.path.join(parsed.dir, `${parsed.name} (Server copy ${require('node:crypto').randomUUID().slice(0,8)})${parsed.ext}`);
      const destination = await this.safePath(copy);
      await this.fs.writeFile(destination, await this.gitBytes('cat-file', 'blob', entry.sides['3'].oid), { flag: 'wx' });
      await this.git('add', '--', copy);
    }
    const selected = entry.sides[choice === 'server' ? '3' : '2'];
    if (choice === 'edited' || selected) {
      const bytes = choice === 'edited' ? require('node:buffer').Buffer.from(content, 'utf8') : await this.gitBytes('cat-file', 'blob', selected.oid);
      if (name.endsWith('.json')) { try { JSON.parse(bytes.toString('utf8')); } catch { throw new Error('The chosen settings are not valid JSON. Correct them before saving.'); } }
      await this.fs.mkdir(this.path.dirname(file), { recursive: true }); await this.fs.writeFile(file, bytes);
      await this.git('add', '--', name);
    } else {
      await this.git('rm', '-f', '--', name);
    }
  }
}

class ConflictReviewModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  onOpen() { this.plugin.reviewOpen = true; this.setTitle('Review your files'); void this.render(); }
  onClose() { this.closed = true; this.plugin.reviewOpen = false; }
  async render() {
    await this.plugin.runAction('review');
    if (this.closed) return;
    const root = this.contentEl; root.empty();
    const entries = this.plugin.review || [];
    root.createEl('p', { text: 'Both originals are protected. Choose what you want to keep; nothing uploads until you finish.' });
    if (!entries.length) {
      root.createEl('p', { text: 'Your choices are saved. Finish syncing to make them available on your other devices.' });
      new Setting(root).addButton(b => b.setButtonText('Save and finish syncing').setCta().onClick(async () => { this.close(); await this.plugin.syncVault(); }));
      return;
    }
    root.createEl('p', { text: `${entries.length} files need your choice` });
    for (const entry of entries) {
      const card = root.createDiv({ cls: 'vault-git-sync-review' });
      card.createEl('h3', { text: entry.path.startsWith('.obsidian/') ? 'Obsidian settings' : entry.path.split('/').pop() });
      card.createEl('p', { text: entry.path });
      if (entry.path.startsWith('.obsidian/')) card.createEl('p', { text: 'Choose the settings you want active. The server is not necessarily newer. Both originals remain available in protected history.' });
      if (entry.path.startsWith('.obsidian/')) {
        try {
          const phone = JSON.parse(entry.sides['2']?.text), server = JSON.parse(entry.sides['3']?.text);
          const keys = [...new Set([...Object.keys(phone), ...Object.keys(server)])].sort().filter(key => JSON.stringify(phone[key]) !== JSON.stringify(server[key]));
          if (keys.length) {
            card.createEl('h4', { text: 'Settings that differ' });
            for (const key of keys) card.createEl('pre', { text: `${key}\nThis computer: ${JSON.stringify(phone[key]) ?? 'Not set'}\nServer: ${JSON.stringify(server[key]) ?? 'Not set'}` });
          }
        } catch { /* Full text previews below remain available. */ }
      }
      const pretty = side => {
        if (!side) return 'Deleted on this side';
        if (side.binary) return 'Attachment — choose a copy to keep.';
        try { return JSON.stringify(JSON.parse(side.text), null, 2); } catch { return side.text; }
      };
      for (const [stage, title] of [['2', 'This computer'], ['3', 'Server']]) {
        const section = card.createEl('details'); section.createEl('summary', { text: title });
        section.createEl('pre', { text: pretty(entry.sides[stage]) });
      }
      const choose = async (choice, content) => {
        const ok = await this.plugin.runAction('resolve', { path: entry.path, fingerprint: entry.fingerprint, choice, content });
        if (ok) await this.render(); else new Notice(this.plugin.feedback, 15000);
      };
      new Setting(card).addButton(b => b.setButtonText(entry.sides['2'] ? 'Use this computer’s version' : 'Keep this deletion').onClick(() => choose('phone')))
        .addButton(b => b.setButtonText(entry.sides['3'] ? 'Use server version' : 'Use server deletion').onClick(() => choose('server')));
      if (entry.sides['2'] && entry.sides['3'] && !entry.path.startsWith('.obsidian/')) new Setting(card).addButton(b => b.setButtonText('Keep both copies').onClick(() => choose('both')));
      if (!entry.sides['2']?.binary && !entry.sides['3']?.binary) {
        const editor = card.createEl('details'); editor.createEl('summary', { text: 'Combine edits' });
        const input = editor.createEl('textarea', { cls: 'vault-git-sync-result' }); input.value = entry.sides['2']?.text || '';
        new Setting(editor).setDesc('Review the full result before saving.').addButton(b => b.setButtonText('Save this result').onClick(() => choose('edited', input.value)));
      }
    }
  }
}

class DeletionReviewModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; this.losses = plugin.attention; }
  onOpen() {
    this.plugin.reviewOpen = true; this.setTitle('Review unexpected changes');
    this.contentEl.createEl('p', { text: 'These changes may remove recently received work or a large group of files. Previous versions are protected. Choose whether to restore them or apply these exact changes.' });
    for (const name of this.losses?.paths || []) this.contentEl.createEl('p', { text: name });
    new Setting(this.contentEl).addButton(b => b.setButtonText('Restore protected files').setCta().onClick(async () => { await this.plugin.runAction('recover'); this.close(); }))
      .addButton(b => b.setButtonText('Apply these changes').onClick(async () => {
        const ok = await this.plugin.runAction('approve-deletions', { fingerprint: this.losses.fingerprint });
        this.close(); if (ok) await this.plugin.syncVault();
      }));
  }
  onClose() { this.plugin.reviewOpen = false; }
}

class SyncHomeModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  onOpen() {
    this.setTitle('Your vault');
    const status = this.contentEl.createEl('p', { text: this.plugin.feedback, attr: { role: 'status', 'aria-live': 'polite' } });
    const update = () => { status.textContent = this.plugin.feedback; };
    this.plugin.listeners.add(update); this.cleanup = () => this.plugin.listeners.delete(update);
    new Setting(this.contentEl).addButton(b => b.setButtonText((this.plugin.attention || this.plugin.outcome?.kind === 'attention') ? 'Review and continue' : 'Sync now').setCta().onClick(async () => { this.close(); await this.plugin.syncVault(); }));
    new Setting(this.contentEl).addButton(b => b.setButtonText('Recover previous work').onClick(() => { this.close(); new HistoryRecoveryModal(this.app, this.plugin).open(); }));
    const details = this.contentEl.createEl('details'); details.createEl('summary', { text: 'Git tools and details' });
    this.toolsCleanup = renderTools(details.createDiv(), this.plugin);
  }
  onClose() { this.cleanup?.(); this.toolsCleanup?.(); }
}

class HistoryRecoveryModal extends Modal {
  constructor(app, plugin) { super(app); this.plugin = plugin; }
  onOpen() { this.setTitle('Recover previous work'); void this.render(); }
  onClose() { this.closed = true; }
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
        .addButton(b => b.setButtonText('Restore file').onClick(async () => {
          const restored = await this.plugin.runAction('restore-history', { path: file.path, oid: file.oid });
          if (restored) { this.close(); new SyncHomeModal(this.app, this.plugin).open(); }
        }));
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
