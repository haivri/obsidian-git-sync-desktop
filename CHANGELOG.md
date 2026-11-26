# Changelog

## 1.8.0

- Save ordinary edits to notes received from another device without a review, including rewording, deleting a few lines, moving tasks and renaming headings.
- Pause before saving only when a note goes back to an older version, loses most of its text, a received file is deleted, or many files are deleted at once. Protection ends once this computer saves its own version.
- Combine more overlaps automatically: lines added at the same place, differing task states, notes created on both devices, whitespace-only differences, and Obsidian settings key by key.
- Replace the conflict review with one card: before, this computer and the other device with changed words marked, three equal buttons, and no confirm step.
- Keep this computer's text in a note while a choice is pending instead of conflict markers.
- Show one notice with a Choose now button when an automatic sync pauses, and resume automatic sync after further edits.
- Document the shared rules in SYNC_RULES.md.

## 1.7.2

- Automatically save additive edits to received notes when the saved words and punctuation remain present, including inline explanations and task completion changes.
- Resolve overlapping additive Markdown edits by keeping the version that contains both sides.
- Keep review for removed or replaced text, ambiguous repeated passages, and incompatible task states.

## 1.7.1

- Show saved and current text side by side in unexpected-change review, highlight differences, and identify added text without calling it a Git conflict.
- Add a visible Merge versions action with passage choices and a complete editable final-note preview. Back up current content and reject stale reviews before saving.
- Replace ambiguous Apply these changes with explicit keep-current-and-sync labels, clear deletion consequences, and a separate older-copy restoration preview.
- Use readable spacing, responsive comparison columns, large controls, and an explicit no-change exit.

## 1.7.0

- Treat checking and unchecking an unambiguous Markdown task as state changes, while continuing to protect removed task text, journal entries, duplicate tasks, and fenced examples.
- Combine Markdown conflicts using the common ancestor and both versions, preserving independent edits and merging task state with wording changes when correspondence is clear.
- Show a combined draft with per-section conflict choices and a final editable preview; unresolved or stale choices cannot be saved.
- Give manual Merge the same guided conflict reporting as automatic desktop and helper sync.
- Preview newer text and checkbox states before whole-file restoration, require confirmation, and reject stale restoration requests, including checkpoint-browser recovery.

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
