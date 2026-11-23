# Write the Morning Notice with a Prompt

> Superseded by ADR 0190: there is no Morning Notice and no Morning Automation.

The Morning Notice is now written by a Morning Automation: an Automation the Morning starts once for each address that has Morning Entries waiting, handed that address's entries and the facts behind its mail, thinking with a Prompt the Account may rewrite, and sending through one tool, `morning.send`. Every Account starts with one, active and unattended, whose Prompt asks for what the fixed composition sent plus the morning's counts. This supersedes the part of ADR 0176 that has code compose the notice; when the Morning comes, how it is sent, retried, and recorded per entry stay as ADR 0176 states.

Each change to what a reader is told — counts at the top, one bubble per mail, the important news first — was a code change, a test change, a pull request, and a release. Everything before the notice already runs on Prompts the Account owns, so the last step to the reader was the one place the Account could not say how its own readers are spoken to.

A model can fail, so letting one write a notice that must arrive needs bounds the model cannot move:

- **What is checked.** `morning.send` accepts a notice only when every entry of its address is named by exactly one text. It also refuses more texts than the address may receive in one Morning (15 on LINE, which is three pushes; 5 on Discord; email texts are joined into one mail), a text over its Channel's limit, and a text that does not carry an entry's links exactly as written. A refused call is told to the model to correct.
- **What happens when it fails.** An address left without an accepted notice — no AI Connection, a model error, a spent budget, a Prompt that never sent an acceptable one — gets the fixed composition, which is kept only for this. A Prompt can change what a reader hears but not whether they hear it.
- **What a retry sends.** The notice is stored as sent, so a retry sends the same texts and never runs the Prompt again, and an entry already carried by a notice is never given to a second run.

The trade-off is fidelity. Code can check which entries a notice tells and that their links survive. It cannot check that a date, a deadline, or a sum was copied rather than retold, so the default Prompt tells the model to copy them unchanged. An Account that would rather not depend on that suspends its Morning Automation and gets the fixed notice.

Considered and rejected: settings for the composition (counts on or off, bubble per mail), which would make every new request a new setting; and having the model write a template that code fills in, which still could not reorder or merge news.
