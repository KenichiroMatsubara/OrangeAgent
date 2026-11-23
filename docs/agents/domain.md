# Domain docs

This repository uses a single domain context.

Before exploring or changing the codebase, read:

- `CONTEXT.md` for canonical domain concepts, vocabulary, and the current specification.
- Relevant architectural decisions under `docs/adr/`. Only decisions that are hard to reverse, surprising without context, and the result of a real trade-off are kept there; everything else is in `CONTEXT.md` or the git history.

Use glossary terms in issue titles, implementation plans, types, and tests.
Avoid synonyms that `CONTEXT.md` explicitly rejects.

If proposed work conflicts with an ADR, surface the conflict instead of
silently overriding it.

Do not write a new ADR for an ordinary change. Write one only when all three
tests in `.claude/skills/domain-modeling/ADR-FORMAT.md` hold; record any other
decision in `CONTEXT.md` when it changes behaviour, and otherwise in the commit
message and pull request description.
