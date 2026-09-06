const { Notice, Plugin, Platform } = require('obsidian');
const COMMAND_NAME = 'Sync vault with Git';

module.exports = class VaultGitSyncPlugin extends Plugin {
  syncing = false;

  supported() {
    return !Platform.isMobile && typeof process !== 'undefined'
      && ['darwin', 'win32', 'linux'].includes(process.platform);
  }

  onload() {
    if (!this.supported()) return;
    this.addRibbonIcon('git-merge', COMMAND_NAME, () => this.syncVault());
    this.addCommand({ id: 'sync-vault-with-git', name: COMMAND_NAME,
      callback: () => this.syncVault() });
  }

  async syncVault() {
    if (!this.supported()) {
      new Notice('Vault Git Sync requires desktop Obsidian on macOS, Windows, or Linux.', 10000);
      return false;
    }
    if (this.syncing) {
      new Notice('Vault sync is already running.');
      return false;
    }
    this.syncing = true;
    const progress = new Notice('Checking vault…', 0);
    const { execFile } = require('node:child_process');
    const { promisify } = require('node:util');
    const fs = require('node:fs/promises');
    const path = require('node:path');
    const os = require('node:os');
    const runFile = promisify(execFile);
    // Keep the Mac path compatible with the existing watcher and shortcut.
    const state = process.platform === 'darwin'
      ? path.join(os.homedir(), 'Library', 'Application Support', 'ObsidianVaultSync')
      : path.join(process.platform === 'win32'
        ? (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'))
        : (process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state')), 'ObsidianVaultSync');
    const lock = path.join(state, 'sync.lock');
    let ownsLock = false;
    let phase = 'Checking vault';
    const status = (message) => { phase = message; progress.setMessage(`${message}…`); };
    try {
      const vaultPath = this.app.vault.adapter.getBasePath?.();
      if (!vaultPath) throw new Error('This vault has no local filesystem path.');
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_MERGE_AUTOEDIT: 'no' };
      if (process.platform === 'darwin') {
        env.PATH = `/opt/homebrew/bin:/usr/local/bin:${env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'}`;
      }
      const executable = process.platform === 'darwin' ? '/usr/bin/git'
        : process.platform === 'win32' ? 'git.exe' : 'git';
      const git = async (...args) => (await runFile(executable, args, {
        cwd: vaultPath, env, timeout: 600000, windowsHide: true, maxBuffer: 4 * 1024 * 1024,
      })).stdout.trim();
      await fs.mkdir(state, { recursive: true });
      try { await fs.mkdir(lock); ownsLock = true; }
      catch (error) {
        if (error.code === 'EEXIST') throw new Error('Another vault sync is running. Try again after it finishes.');
        throw error;
      }
      const root = await git('rev-parse', '--show-toplevel');
      if (await fs.realpath(root) !== await fs.realpath(vaultPath)) {
        throw new Error('The vault must be the root of its own Git repository.');
      }
      const gitDir = await git('rev-parse', '--absolute-git-dir');
      for (const marker of ['MERGE_HEAD', 'MERGE_AUTOSTASH', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
        try { await fs.access(path.join(gitDir, marker)); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        throw new Error('Git has an unfinished operation. Recover saved edits or resolve conflicts before syncing.');
      }
      if (await git('diff', '--name-only', '--diff-filter=U')) {
        throw new Error('Resolve existing Git conflicts before syncing.');
      }
      const branch = await git('branch', '--show-current');
      if (!branch) throw new Error('Check out a branch before syncing; Git is in detached HEAD state.');
      await git('remote', 'get-url', 'origin');
      try { await git('lfs', 'version'); }
      catch { throw new Error('Git LFS is required. Install Git LFS and make it available on PATH, then retry.'); }
      status('Saving local changes');
      await git('add', '--all');
      if (await git('diff', '--cached', '--name-only')) {
        await git('commit', '-m', `vault sync: ${new Date().toISOString()}`);
      }
      if (await git('status', '--porcelain')) {
        throw new Error('The vault changed while saving. Your checkpoint is safe; run sync again.');
      }
      status('Getting remote changes');
      await git('pull', '--no-rebase', '--no-autostash', '--no-edit', 'origin', branch);
      status('Uploading changes');
      await git('push', 'origin', `HEAD:refs/heads/${branch}`);
      status('Verifying sync');
      const head = await git('rev-parse', 'HEAD');
      const remote = await git('ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`);
      if (remote.split(/\s+/)[0] !== head) {
        throw new Error('The server changed again. Run sync again to receive the latest edits.');
      }
      const changed = await git('status', '--porcelain');
      new Notice(changed ? 'Checkpoint uploaded; newer local edits need another sync.' : `Vault synced · ${head.slice(0, 8)}`, 7000);
      return !changed;
    } catch (error) {
      const detail = String(error.stderr || error.message || error)
        .replace(/(https?:\/\/)[^\s/]*@/g, '$1[redacted]@').trim();
      new Notice(`${phase} stopped: ${detail.slice(-1800)}`, 20000);
      return false;
    } finally {
      if (ownsLock) {
        try { await fs.rmdir(lock); }
        catch { new Notice('Sync ended, but its lock could not be released. Check the desktop sync helper.', 10000); }
      }
      progress.hide();
      this.syncing = false;
    }
  }
};
