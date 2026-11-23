---
status: superseded by ADR 0203
---

# A Skill is edited as a directory, a file at a time

A Skill is one directory in R2, and it is edited as any directory is: a file is written as the bytes sent, deleted, or moved, one at a time, in place. Saving no longer makes a revision. ADR 0191 made every save a new folder of the whole Skill, and that is what forced each save to send every file at once, first as base64 inside JSON, so a template could not simply be written as the file it is. A run now records, for every Skill it started with, the SHA-256 of each file it read, so what caused its writes can still be named.

This replaces what ADR 0191 says about revisions; where a Skill is kept, and that D1 is only its index, stand.

## Consequences

- **A Skill's earlier contents are not kept.** A run's record names the digest of each file it read, not a copy, so a file changed after the run cannot be read back as it was. Nothing in the product read a past revision.
- **A run reads the directory as it is when the run starts.** A file written while a run is going is read by the next run.
- **The revisions already kept stay.** The current revision's folder is the Skill's directory and is written in place from now on; earlier folders, and a revision still kept as D1 rows, are left as they are. When the product rewrites one of its own starting Skills it still writes a revision, whose folder becomes the directory.

## Considered and rejected

- **Keep a revision for every file written.** Each write would copy every unchanged file into a new folder, or revisions would list files by digest, which ADR 0191 rejected; either keeps a history no screen or run reads, at the cost of making a file edit a folder save again.
