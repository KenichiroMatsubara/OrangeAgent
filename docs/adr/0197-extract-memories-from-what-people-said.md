---
status: accepted
---

# Extract memories from what people said, and judge them before keeping them

The Memory stops behaving as mcp-memory does (ADR 0195). Instead of keeping whatever words an AI passes to `addToMCPMemory`, it keeps the exchange itself as an immutable Episode — an Operator Chat exchange once it completes, a conversation a member's CLI passes to `memory.add`, or words a member types on 記憶 — and extracts facts from it. A fact is kept only when it quotes a span of its Episode that the Worker finds there, and after Clef has judged its specificity, its source, and whether it duplicates, replaces, or contradicts a fact already kept. No generative model judges: a relation is asked as the separate steps it takes and the Worker combines the answers, and a judgement still in doubt waits on 記憶 for a member. A replaced fact is kept as superseded rather than deleted, a rejected one is kept with its reason, and a search answers that it has no certain memory rather than returning the nearest guess. The design is in `docs/implementation/memory.md`.

The Account's D1 stays the record and Vectorize becomes an index rebuilt from it, rather than moving the Memory into a Durable Object per Account as the cf-memory design this follows proposed: each Account already has its own D1, with Time Travel for point-in-time recovery, and a second store of record would sit outside the migration rehearsal every pull request runs (ADR 0174). For the same reason keyword search is an ordinary table of character bigrams rather than an FTS5 virtual table: D1 does not export a database that holds a virtual table, so one FTS5 table in one Account would stop the rehearsal for every pull request.

ADR 0195 chose mcp-memory's behaviour so that an agent moved from that server found the same tools and answers. That compatibility is given up. mcp-memory's description asks the AI to keep something after every message, and what it keeps is its own paraphrase, kept again each time and never reconciled with what it contradicts; a public audit of a memory server built the same way (mem0 issue #4573) found most of what it had kept to be noise. That is the unchecked claim ADR 0150 warned of, and a screen where members read every memory does not scale to it. Who may add to the Memory is unchanged: only a run a person is at, never an Automation, never an Access Token; an Automation reads it only when its Tool Grant names `memory.search`.

## Considered Options

- **Keep mcp-memory's behaviour and clean up on 記憶.** Members would have to audit every paraphrase by hand; nothing would stop a corrected fact from being returned beside its correction.
- **Stricter rules on what the AI passes in.** Duplicate and length checks on `addToMCPMemory` still keep the AI's summary, not what was said, so a hallucinated detail has nothing to be checked against.
- **A Durable Object per Account holding the Memory in its own SQLite, with FTS5.** It gives transactions and alarms, but D1 already gives both through `batch()` and the Account Job tick, and it would put a store of record outside the rehearsal and the production export.
- **The Account's own AI Connection for extraction and judgement.** Thresholds are calibrated against one model; letting each Account's chosen model judge would make them meaningless. Workers AI already embeds every memory.

## Consequences

- `addToMCPMemory` and `searchMCPMemory` are removed; Tool Grants naming `searchMCPMemory` are rewritten to `memory.search`, and an Automation Revision that names it is read as `memory.search`.
- Operator Chat no longer has a tool to keep a memory; whether its exchanges become Episodes is one Account setting on 記憶.
- Erasing a memory for good also blanks its evidence in the Episode, or re-extraction would bring it back.
