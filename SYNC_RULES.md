# Sync rules

These rules are shared by VaultBridge (iPhone) and Git Sync Desktop (Obsidian
plugin). Both apps implement them and test them with the same cases. The aim:
anything that loses nothing happens without a question, and a question is asked
only when two people-written wordings truly clash.

Git keeps every saved version, and both apps keep recovery references before
they combine anything. "Automatic" below never discards a version; it only
decides what the note shows next.

## A. Saving this device's own edits

Edits save without asking. Rewording, ticking, unticking, deleting a few lines,
moving or re-indenting tasks, renaming headings and whitespace changes are all
ordinary editing, including in a note that just arrived from another device.

A save pauses for a check only when:

1. **A note went back to an older version.** After a note arrived from the
   other device, this device's copy again holds everything the older version
   had and none of what the other device added. That is the shape of a stale
   editor buffer saved over newer text. Ticks and new typing on top of the old
   text do not hide it; a reworded arriving line is an edit, not a loss.
2. **Most of a note was removed.** At least 10 non-empty lines gone and at
   most half the note left.
3. **A received file was deleted**, or a received non-Markdown file (outside
   `.obsidian/`) returned to exactly its previous bytes.
4. **Many files were deleted at once** (20 or more, or 5 or more that make up
   a fifth of the vault).

Protection of a received file ends when this device saves its own version of
it. An approved change is never asked about again.

## B. Combining with the other device

Combined without asking:

| Situation | Result |
|---|---|
| Only one device changed a passage | That change |
| Both made the same change | That change |
| Changes on different or adjacent lines | Both |
| One ticks a task, the other rewords it | Reworded and ticked |
| Both change a task's state differently | The completed state |
| Both add different lines at the same place | Both; other device's lines first |
| Both created the same note; identical, or one holds all of the other | The fuller note |
| Only line endings or trailing spaces differ | This device's text |
| `.obsidian/**/*.json`, different keys | Merged key by key |
| `.obsidian/**/*.json`, same key, different values | The newer save's value |

## C. When a choice is asked

- Both devices changed the wording of the same line differently.
- One device deleted a note the other edited.
- An attachment or other non-mergeable file changed on both devices.
- A file was renamed two different ways.

The choice is shown as one card: the note's name, one sentence saying what
happened, the text before and on each device with the changed words marked,
and three equal buttons (keep this device's, keep the other device's, keep
both). The last choice saves and uploads by itself. Until a choice is made the
note on disk shows this device's text; conflict markers are never written
into a note.
