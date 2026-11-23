---
status: superseded by ADR-0197
---

# Keep a Memory people can read and correct

An Account keeps a Memory that works exactly as mcp-memory (github.com/Puliczek/mcp-memory) does. Its runs reach it through mcp-memory's two tools, unchanged in name, description, parameters, storage, search, and answer: `addToMCPMemory` keeps what the AI chooses to keep, as often as the description asks it to, and `searchMCPMemory` returns the memories nearest in meaning. Only a run a person is at may keep one: Operator Chat and an Operator Token's CLI. An Automation may only search, when its Tool Grant names `searchMCPMemory`, and never keeps one, not even as a Planned Write. An Access Token reaches neither. This revises ADR 0150, which gave an Automation no memory at all.

The Memory replaces the mcp-memory server members ran beside their CLI, so it behaves as that server did and nothing else: an agent that used it finds the same tools and the same answers. A memory's meaning is a Workers AI `@cf/baai/bge-m3` embedding kept in one Vectorize index with its words as metadata, under the Account's own namespace where mcp-memory used the user's; it is kept there first and as a row of the Account's D1 after; a search asks for 10 and keeps those scoring above 0.5. FlareChat adds only what its 記憶 screen shows: who wrote each memory and in which conversation, who last changed it, and which answers kept or recalled it, and the screen lists, searches, adds, corrects, and deletes memories.

ADR 0150 refused a scratchpad because it would become "a store of the agent's own claims that nobody checks". The Memory answers that objection with the screen rather than with the tools. Every memory is written while a person watches the exchange that writes it, every memory is listed on 記憶 with who wrote it, and a member searches it there exactly as the AI does, and corrects or deletes any memory whoever wrote it. An Automation, which runs when nobody is asking, only reads what people have been able to check. Run Transcripts are still never fed back.

## Considered Options

- **No memory, as ADR 0150 decided.** Members already used mcp-memory from their CLI to carry preferences between sessions; those memories were neither in the Account nor visible to its other members, and Operator Chat could not recall them.
- **FlareChat's own memory tools, with stricter rules than mcp-memory's.** Keeping only what the administrator asks to keep, refusing duplicates and long texts, and letting the AI forget would differ from the server members already used, and an agent moved from it would behave differently. The Account's people chose mcp-memory's behaviour as it is.
- **Let an Automation keep memories too, as Planned Writes.** An Automation runs when nobody is asking, so what it keeps would be exactly the unchecked claim ADR 0150 refused.
- **Give an Access Token the Memory.** An outside agent acts on documents its operator never wrote; reading the Account's preferences would hand it facts the Account kept for its own runs.
