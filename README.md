# Vault Git Sync (Desktop)

An Obsidian plugin for synchronizing a vault with Git on **macOS, Windows, and
Linux**. Use the ribbon button or **Vault Git Sync (Desktop): Sync vault with Git**
in the command palette. It saves a local commit, merges server updates without
rebasing, uploads, and checks that the server and computer have the same commit.

This is the desktop companion to [VaultBridge](https://github.com/haivri/VaultBridge)
for iPhone. Both use your own repository. No VaultBridge service is required;
GitHub, Forgejo/Gitea, and other Git hosts work through your existing Git setup.
This plugin is distributed on GitHub and has not been submitted to the Obsidian
community directory.

## Install

1. Install Git and Git LFS. On macOS, use `xcode-select --install` and Homebrew's
   `brew install git-lfs`. On Windows, install Git for Windows and Git LFS; on
   Linux, install `git` and `git-lfs` with your distribution's package manager.
   Run `git lfs install`. Ensure Git and Git LFS are on your system PATH, then
   restart Obsidian. Standard Homebrew paths are added automatically on macOS.
2. Configure Git identity and remote authentication in a terminal. The plugin
   uses Git's existing credentials; it does not store tokens.
3. Open a vault that is the root of its own Git repository, with an `origin`
   remote and a checked-out branch. The matching branch must exist on the server.
   Confirm you can fetch and push from a terminal first.
4. Download `main.js` and `manifest.json` from the
   [latest release](https://github.com/haivri/obsidian-vault-git-sync-desktop/releases/latest).
   Put both in `<vault>/.obsidian/plugins/vault-git-sync/`. Alternatively, extract
   `vault-git-sync.zip` into `<vault>/.obsidian/plugins/`.
5. Restart Obsidian, allow community plugins, and enable **Vault Git Sync (Desktop)**.
6. Click the Git merge ribbon icon. Progress and any failure appear in Obsidian.

The internal ID stays `vault-git-sync` so existing installations upgrade in place.
Version 1.2.0 includes the complete sync implementation; the former Mac-only
`Sync Obsidian Vault.command` script is no longer required by the plugin.
The plugin provides manual sync. An existing Mac watcher can continue running;
the legacy watcher and shortcut share its lock.

## Sync behavior

- All tracked changes and unignored new files are staged and committed.
  Configure `.gitignore` before syncing. Local commits remain safe if networking fails.
- Attachments use Git LFS hooks and filters. Staging failure stops before pull or push.
- Only one cooperating local sync runs at a time. Existing merge/rebase recovery
  states stop sync before staging. A forcibly stopped process can leave a lock;
  it is never removed automatically while another sync may still be running.
- Conflicts stay visible for manual resolution. No force push, automatic conflict
  resolution, reset, or implicit autostash is performed.
- Mobile is excluded by the manifest and runtime guard. iPhone sync is handled
  by VaultBridge. A vault copied to Windows must use Windows-compatible filenames.

## Computer and iPhone setup

Use the same remote and branch in this plugin and VaultBridge. Sync before
switching devices, then sync the receiving device. Matching commits establish
agreement on the tracked Git tree; LFS attachments must also be downloaded.
Folder sizes can differ because Git history, LFS caches, ignored files, and
filesystem allocation are local to each device. Git sync does not replace backups.

## Troubleshooting

- **Git LFS required:** install Git LFS and retry. Do not disable filters to bypass
  an attachment error. Restart Obsidian after changing PATH on Windows or Linux.
- **Unfinished operation/conflicts:** preserve your work and finish recovery in
  a terminal. The plugin leaves recovery decisions to you.
- **Another sync running:** allow it to finish. After a crash, verify no sync
  process is active before removing the empty `sync.lock` directory under
  `~/Library/Application Support/ObsidianVaultSync` on macOS,
  `%LOCALAPPDATA%/ObsidianVaultSync` on Windows, or
  `${XDG_STATE_HOME:-~/.local/state}/ObsidianVaultSync` on Linux.
- **Authentication/network error:** fetch and push from a terminal to diagnose
  the connection. Interactive credential prompts are disabled inside Obsidian.

## Development and releases

No dependencies or transpilation are required. Run `npm run lint`, `npm test`,
and `npm run build`. Tests use temporary local Git repositories and mocked
Obsidian UI, never a real vault or remote account. CI runs the suite on macOS,
Windows, and Linux; check the Actions results for the release commit. Obsidian
UI testing is performed locally on macOS.

Publish the same clean source commit to private Forgejo and public GitHub, then
deploy runtime artifacts into each local vault while preserving `data.json`.
Tag releases with the manifest version (e.g. `1.2.0`) and attach `main.js`,
`manifest.json`, and `vault-git-sync.zip`. Never publish vault content, credentials,
or machine-specific configuration.

MIT licensed. This independently implemented plugin contains no VaultBridge
or GitSync.md application code.
