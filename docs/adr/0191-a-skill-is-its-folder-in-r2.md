---
status: superseded by ADR 0203
---

# A Skill is its folder, kept in R2

A Skill is kept as the folder Claude's Agent Skills write, file for file: every file of a revision, SKILL.md among them, is an object in R2 at `skills/{account}/{skill}/{folder}/{path}`, as its own bytes under its own media type, and each revision names its folder. D1 keeps only what names the Skill — its name, its description, and which folder each revision is — so a name is still one Skill's and a run still records the revision it read. Before this, a Skill was a row of words and a table of text files in Account D1, which allowed only text, made SKILL.md something written out of columns rather than a file, and held every file in a database built for records.

## Consequences

- **A D1 Time Travel restore no longer restores a Skill's files.** It restores which folder each revision names, and that folder is never rewritten, so a restored revision still opens the folder it named. A save that fails after writing its folder leaves that folder unnamed, and it is removed.
- **Revisions written as rows stay readable.** Migration 0045 only adds the folder column; a revision without one, and the starting Skills the product writes, become a folder the first time the Worker reads them, because a migration cannot write to R2.

## Considered and rejected

- **Keep the files in D1 as blobs.** It allows any kind of file and keeps one restore, but D1 rows and statements are small, so a folder of scripts, images and documents would be split across many rows and a save across many statements, and the database the Account's records live in would hold every file of every revision.
- **Store each file once by its digest and have revisions list them.** It saves copying unchanged files into each revision's folder, but a revision would no longer be a folder anyone can open as it is.
