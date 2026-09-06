# Vault Git Sync Plugin Operating Contract

- Keep the canonical source identical to both installed vault copies.
- Preserve the left-ribbon sync command and visible failure reporting.
- Do not place vault credentials, remote tokens, or machine-specific paths in
  this repository.
- Before committing a release, verify existing installed hashes and preserve
  any divergent version. Push the same clean source commit to Forgejo and
  GitHub before deploying, then verify both installed copies match the new
  source. Follow the vault's `_obsidian-os/PLUGIN_RELEASES.md` workflow.
