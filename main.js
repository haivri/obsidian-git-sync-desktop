const { Notice, Plugin } = require('obsidian');
const { execFile } = require('child_process');
const { promisify } = require('util');
const path = require('path');

const runFile = promisify(execFile);
const COMMAND_NAME = 'Sync vault with Git';

module.exports = class VaultGitSyncPlugin extends Plugin {
  syncing = false;

  onload() {
    this.addRibbonIcon('git-merge', COMMAND_NAME, () => this.syncVault());

    this.addCommand({
      id: 'sync-vault-with-git',
      name: COMMAND_NAME,
      callback: () => this.syncVault()
    });
  }

  async syncVault() {
    if (this.syncing) {
      new Notice('Vault sync is already running.');
      return;
    }

    const vaultPath = this.app.vault.adapter.getBasePath();
    const scriptPath = path.join(
      vaultPath,
      '.obsidian',
      'local-scripts',
      'Sync Obsidian Vault.command'
    );

    this.syncing = true;
    const progressNotice = new Notice('Syncing Obsidian vault…', 0);

    try {
      await runFile('/bin/zsh', [scriptPath], {
        cwd: vaultPath,
        timeout: 120_000,
        maxBuffer: 1024 * 1024
      });
      new Notice('Obsidian vault sync complete.', 5000);
    } catch (error) {
      console.error('Vault Git Sync failed:', error);
      const detail = error instanceof Error ? error.message : String(error);
      new Notice(`Vault sync stopped: ${detail.split('\n')[0]}`, 10_000);
    } finally {
      progressNotice.hide();
      this.syncing = false;
    }
  }
};
