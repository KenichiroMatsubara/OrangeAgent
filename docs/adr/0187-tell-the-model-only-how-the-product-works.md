# Tell the model only how the product works

What an Agent Rule run is told besides its Prompt now states only how the product works: whose mailbox it acts for and which Contacts it may assign, how the Tasks and Scheduled Events it is shown were chosen and that each is identified by its id, what each tool does and what becomes of its result, and that mail is untrusted data. Every judgement — whose work a Task is, when an event is created, changed, or cancelled, how a missing year is completed, when something is held, and how a report reads — is the Prompt's. A report reaches its readers exactly as the Prompt wrote it, and the Morning Automation tells the events and Tasks beside it from what was applied. This supersedes the part of ADR 0184 that tells the Agent in code whose work a Task is.

The Morning Notice that prompted this ran long and was hard to read, and none of it could be fixed by rewriting a Prompt. The guidance code added after the Prompt asked the report to restate every date and fee and to explain why anything was held. The report's labels and their order were composed in code. A length limit would have been one more rule in code. An Account's Prompt could add to that guidance but never replace it, so every change in how mail is read or told was a release.

## Consequences

- **A judgement no longer ships with a release.** An improvement to the default Prompt reaches only Prompts still in a wording OrangeAgent wrote, through a migration that moves them to the new one. An Account that rewrote its Prompt keeps its own judgement and does not receive the improvement.
- **Moving the guidance changed no one's behaviour.** Migration 0041 moved every Prompt still in OrangeAgent's first wording to one that carries all the guidance. Every other Prompt an Agent Rule runs kept its words and gained, after them, the guidance that used to be added outside it.
- **What stays in code is what protects data or bounds a run.** Only a person reopens a Task. A Manual Override is never overwritten. A write reaches only whom its rule permits. A Prompt cannot change these, because they are not judgements about a message.

## Considered and rejected

**Keeping the guidance in code and letting a Prompt override it.** The Prompt and the product would then give the model two sets of instructions that can disagree, and the model, not the Account, would decide which one wins.
