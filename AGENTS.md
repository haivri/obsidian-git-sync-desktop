# Git Sync Desktop Plugin Operating Contract

- Keep the canonical source identical to both installed vault copies.
- Preserve the left-ribbon sync command and visible failure reporting.
- Follow `SYNC_RULES.md`: anything that loses nothing syncs without a question;
  a choice is asked only for a real clash of wording, a delete-versus-edit, or
  a note that went back to an older version (Robert, 2026-11-26). Keep the
  rules identical to VaultBridge's copy and change both together.
- Recovery screens must use plain language, show both versions and their
  differences, provide an explicit merge preview, and name exactly what each
  action keeps or replaces. Keep destructive restoration separate, use large
  controls and clear spacing, and always offer an exit that changes nothing.
- Do not place vault credentials, remote tokens, or machine-specific paths in
  this repository.
- Before committing a release, verify existing installed hashes and preserve
  any divergent version. Push the same clean source commit to Forgejo and
  GitHub before deploying, then verify both installed copies match the new
  source. Follow the vault's `_obsidian-os/PLUGIN_RELEASES.md` workflow.
