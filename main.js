const { Notice, Plugin, Platform, Modal, PluginSettingTab, Setting } = require('obsidian');
const COMMAND_NAME = 'Sync vault with Git';

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
    this.addCommand({ id: 'manual-git-tools', name: 'Open manual Git tools', callback: () => new SyncToolsModal(this.app, this).open() });
    for (const action of ACTIONS) this.addCommand({ id: `manual-${action.id}`, name: action.title, callback: () => this.runAction(action.id) });
    this.addCommand({ id: 'force-merge', name: 'Force merge: choose conflict preference', callback: () => new ForceMergeModal(this.app, this).open() });
  }

  async syncVault() { return this.runAction('sync'); }

  async runAction(action, options = {}) {
    if (!['sync', 'commit', 'pull', 'merge', 'push', 'status', 'finish', 'force'].includes(action)) return false;
    if (action === 'force' && !['ours', 'theirs'].includes(options.preference)) return false;
    if (!this.supported()) {
      new Notice('Vault Git Sync requires desktop Obsidian on macOS, Windows, or Linux.', 10000);
      return false;
    }
    if (this.syncing) {
      new Notice('Vault sync is already running.');
      return false;
    }
    this.syncing = true;
    this.report('Checking vault…');
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
    const status = (message) => { phase = message; progress.setMessage(`${message}…`); this.report(`${message}…`); };
    const done = (message) => { this.report(message); new Notice(message, 10000); return true; };
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
      let pendingOperation = false;
      for (const marker of ['MERGE_HEAD', 'MERGE_AUTOSTASH', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'sequencer']) {
        try { await fs.access(path.join(gitDir, marker)); }
        catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        pendingOperation = true;
        if (action === 'status' || (action === 'finish' && marker === 'MERGE_HEAD')) continue;
        throw new Error('Git has an unfinished operation. Resolve conflicts, then use Finish resolved merge. Other recovery operations must be completed in a Git client.');
      }
      const conflicts = await git('diff', '--name-only', '--diff-filter=U');
      if (conflicts && action !== 'status') throw new Error('Some files still conflict. Resolve and stage them in a Git client, then use Finish resolved merge. Nothing was uploaded.');
      const branch = await git('branch', '--show-current');
      if (!branch) throw new Error('Check out a branch before syncing; Git is in detached HEAD state.');
      const localOnly = action === 'commit' || action === 'finish';
      if (!localOnly) await git('remote', 'get-url', 'origin');
      if (action !== 'status') {
        try { await git('lfs', 'version'); }
        catch { throw new Error('Git LFS is required. Install Git LFS and make it available on PATH, then retry.'); }
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
        await git('commit', '--no-edit');
        return done(`Merge saved locally · ${(await git('rev-parse', 'HEAD')).slice(0, 8)}. Nothing uploaded. Use Push when ready.`);
      }
      if (['pull', 'push'].includes(action)) {
        if (await git('status', '--porcelain')) throw new Error('Save your edits with Commit locally first. No files were pulled or uploaded.');
        const remoteHead = await fetchRemote();
        if (action === 'pull') {
          const ahead = Number(await git('rev-list', '--count', `${remoteHead}..HEAD`));
          if (ahead) throw new Error('This computer has saved work the server does not have. Use Merge to combine both histories, or Push if only this computer changed.');
          status('Bringing newer server changes here');
          await git('merge', '--ff-only', '--no-autostash', remoteHead);
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
        if (action === 'commit') return done(`Saved locally · ${(await git('rev-parse', 'HEAD')).slice(0, 8)}. Nothing uploaded.`);
      }
      if (mergeHead) {
        const checkpoint = `refs/vault-git-sync/checkpoints/${Date.now()}`;
        const checkpointHead = await git('rev-parse', 'HEAD');
        await git('update-ref', checkpoint, checkpointHead);
        status('Combining computer and server changes');
        const args = ['merge', '--no-edit', '--no-autostash'];
        if (action === 'force') args.push(`-X${options.preference}`);
        try { await git(...args, mergeHead); }
        catch (error) { throw new Error(`Merge stopped. Restore point ${checkpointHead.slice(0, 8)} protects your saved computer version. Nothing uploaded. ${String(error.stderr || error.message).trim()}`, { cause: error }); }
        return done(`Combined locally · ${(await git('rev-parse', 'HEAD')).slice(0, 8)}. Nothing uploaded. Restore point: ${checkpointHead.slice(0, 8)}. Use Push when ready.`);
      }
      if (action === 'sync') {
        status('Getting remote changes');
        await git('pull', '--no-rebase', '--no-autostash', '--no-edit', 'origin', branch);
      }
      status('Uploading changes');
      await git('push', 'origin', `HEAD:refs/heads/${branch}`);
      status('Verifying sync');
      const head = await git('rev-parse', 'HEAD');
      const remote = await git('ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`);
      if (remote.split(/\s+/)[0] !== head) {
        throw new Error('The server changed again. Run sync again to receive the latest edits.');
      }
      const changed = await git('status', '--porcelain');
      done(changed ? 'Checkpoint uploaded; newer local edits need another sync.' : `${action === 'push' ? 'Saved changes uploaded' : 'Vault synced'} · ${head.slice(0, 8)}`);
      return !changed;
    } catch (error) {
      const detail = String(error.stderr || error.message || error)
        .replace(/(https?:\/\/)[^\s/]*@/g, '$1[redacted]@').trim();
      this.report(`${phase} stopped: ${detail.slice(-1800)}`);
      new Notice(this.feedback, 20000);
      return false;
    } finally {
      if (ownsLock) {
        try { await fs.rmdir(lock); }
        catch { new Notice('Sync ended, but its lock could not be released. Check the desktop sync helper.', 10000); }
      }
      progress.hide();
      this.syncing = false;
      this.report(this.feedback);
    }
  }
};

const ACTIONS = [
  { id: 'status', title: 'Check what needs doing', button: 'Check status', description: 'Checks the server and tells you whether to save, pull, combine, or upload. Does not change your notes.' },
  { id: 'commit', title: 'Save on this computer only', button: 'Commit locally', description: 'Saves every changed or new, unignored file as a local restore point. Works offline and uploads nothing.' },
  { id: 'pull', title: 'Bring newer server changes here', button: 'Pull', description: 'Downloads changes when this computer has no unsaved edits or competing commits. Does not upload or rewrite your history.' },
  { id: 'merge', title: 'Combine computer and server changes', button: 'Merge', description: 'Checks the server, saves your edits, then combines both histories here. Conflicts stop for review. Nothing is uploaded.' },
  { id: 'push', title: 'Upload saved work', button: 'Push', description: 'Checks the server, then uploads existing local commits. Save your edits first. Newer server work blocks the upload.' },
  { id: 'finish', title: 'Finish a resolved merge', button: 'Finish merge', description: 'After resolving and staging conflicted files in a Git client, saves the merge locally. Uploading is still a separate step.' },
];

function renderTools(container, plugin) {
  container.empty();
  container.addClass('vault-git-sync-tools');
  container.createEl('p', { text: 'Usually, Sync now is all you need. Use the individual steps when you want more control.' });
  const feedback = container.createDiv({ cls: 'vault-git-sync-feedback', attr: { role: 'status', 'aria-live': 'polite' } });
  const buttons = [];
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
