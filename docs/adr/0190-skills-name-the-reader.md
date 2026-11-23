# Skills name the reader, and every Automation runs at a time

An Automation is now when it runs, the Skills it runs, and the tools it may call. Whom it tells is written in its Skills, in words the Account reads and edits, and its run may send to any of the Account's Contacts; the run is told to send to nobody its Skills do not name. Reading mail is something a Skill asks for — "the mail that arrived since this Automation last ran" — rather than a Trigger: the mail Trigger, its Selection Policy and priority, the Morning with its Morning Entries, Morning Notice and Morning Automation, the Contact List an Automation named, and the product's own Task and attendance reminders are gone. Reminding a Task's assignee is a Skill and an Automation like any other.

We chose this because the product had come to decide who hears what in five places the Account could not see from a Skill: an Automation's Contact List, the readers a mail run's report was kept for, the first Channel a reader was reachable on, the address each Morning Notice was composed for, and the assignee each reminder milestone chose. Each was added to protect something real — a run reaching someone it should not, and a LINE quota spent on one push per mail — but together they made a simple instruction ("each morning, read the mail, put the events on the calendar, and tell 山田さん") a configuration spread across four screens that still did not say it. A daily run that reads the day's mail and sends one message per person keeps the quota the Morning existed to keep, and says so in the Skill.

## Consequences

- **Reach is no longer a bound the product enforces on an Automation.** An unattended Automation with `channel.send` can message any active Contact; what keeps it to the right people is its Skill, its Tool Grant, its Suppression Window, the approval Execution Mode for an Account that wants a person in the loop, and the trial run on its page. An Access Token, which is an outside agent rather than the Account's own instructions, keeps its Contact List.
- **A day of mail is one run.** One run reads every mail since the last, and nothing counts against it, neither its tokens, its tool calls, nor its writes: only the model's own context window limits what one run holds. Mail is not taken in by anything else; a mail becomes a Source Message only when a write names it.
- **Migration 0042 archives rather than converts.** The mail and Morning Automations stay archived for their history, and each Account is given 毎朝のメール処理 and タスクのリマインド in their place; the former mail Skill is rewritten to tell the Contact named 要約送信グループ, so an Account's readers are named in the Skill rather than guessed from its old Contact List.

## Considered and rejected

- **Keep the Contact List as a ceiling under the Skill.** It would catch a Skill that names someone it should not, but it brings back the second place a reader must be configured, which is the confusion this removes.
- **Keep the mail Trigger beside timed Automations.** It acts within the hour rather than the next morning, but it is what made the Morning necessary for the LINE quota, and a Skill can be run hourly when the Account wants that.
