# Changelog

## 1.6.1

- Record local-save time when a commit or integration completes, rather than after networking. No-op checks preserve the existing save time.

## 1.6.0

- Retain protection per note through unrelated syncs, restarts, and additive saves.
- Review missing incoming Markdown text, including partial overwrites and staged losses.
- Find notes by name, compare historical versions and local recovery copies, and restore selected changes without rolling back other edits.
- Bind review and selective restoration to current file, index, HEAD, and protection state.
- Show actual local-save and server-verification times across helper runs and offline saves.

## 1.5.1

- Keep the Git tools disclosure labeled and make status-bar messages concise.
- Show Review and continue when the background helper reports attention.

## 1.5.0

- Guided conflict review with settings differences, guarded choices, and a clear finish action.
- Verified saved status, quiet automatic saving, backoff, and one shared plugin/helper engine.
- Protected merge parents, suspicious deletion/reversion review, and individual file recovery.
- Recover abandoned locks only when their owner and Git child are no longer alive.
