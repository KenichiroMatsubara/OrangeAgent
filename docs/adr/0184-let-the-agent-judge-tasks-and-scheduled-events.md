# Let the Agent judge Tasks and Scheduled Events

An Agent Rule decides what a Source Message means for the Account's Tasks and Scheduled Events. It decides whether the message concerns existing work or an existing event, and whether to create, change, complete, cancel, or leave it. The product owes that judgement two things. It shows the Agent everything the judgement needs, and it performs every write under the rules that protect people's data. It never infers sameness itself. A Task and a Scheduled Event are identified by their id alone.

## Why not code

The same work does not keep the same words. A deadline is extended, a reminder comes from another sender, or a re-planned run words the title differently. The unique index on `(source_message_id, deadline, title)` deduplicated one Source Message against itself, and only while the Agent repeated itself word for word. The Schema Rule's event pipeline has the same flaw. It extracts candidates, then asks the model to correspond them with the Calendar, so a later mail that brings a revised agenda but states no event fields yields no candidate. That agenda never reaches its event.

The duplicates Accounts actually saw were of finished work. `query_tasks` returned the hundred oldest Tasks, so an Account with more than a hundred showed the Agent only old ones. The product's part, then, is sight:

- A run starts with every Task whose deadline falls on or after sixty days ago, or that has no deadline and changed in that time. It also starts with every Scheduled Event starting in that window, with its attachments, Manual Overrides, and linked Tasks.
- Both sets are given in every status. A completed Task is exactly what a later reminder must be matched against.
- Nothing is cut silently: an oversized result says it was truncated. Older records are found by asking for a date range or a phrase.

## What the product still enforces

- A planned write is applied once. A Task records the Rule Effect that created it.
- Calendar writes go through the product's calendar path, the one the Schema Rule uses today: `sendUpdates=none`, roster invitation, the Recipient Snapshot, the composed description, and Drive publication. The Agent's current `create_scheduled_event` bypasses all of these and is replaced. ADR 0145 keeps them in the platform because they are what an agent does worst.
- A Manual Override is never overwritten.
- Only a person reopens a completed or cancelled Task.

## Reports

What the Agent cannot settle under its Prompt is reported, not improvised.

- **Assumption.** The Prompt covers the situation but the Agent had to assume something. It acts and reports an Automation Warning.
- **Held.** The Prompt does not cover the situation, or acting would break a rule above. It does nothing and reports an Automation Exception.

Reports reach people in the message the Agent already writes to its permitted destinations, together with what it changed. A run that reports sends that message even when it changed nothing else. No destination is added for this.

## Rejected

**Checking structurally whose work a Task is.** `create_task` would have had to cite the request, and was refused when the citation sat only in quoted text. Telling the Agent whose Account it works for, and what the Account sent itself, is enough for a capable model. Ten simulated Source Messages were modelled on a volunteer organization's typical mail. Given those instructions, a Claude Sonnet 5.5 subagent created no Task from the club's own invitation or from a guest's reply quoting it. It created the one Task a district office asked for and recreated no completed Task. The check would also have refused the Account forwarding an outside request to itself.

**Keeping the seven-day bound for the Agent.** Automatic correlation never merges two start times more than seven days apart, so a distant match cannot move an invitation list onto a different meeting. That bound limits automatic correlation. An Agent moving an event further does so as an explicit judgement and reports what it assumed.

## Consequences

The judgement is only as good as what it is shown. Work older than the window can still be duplicated when the Agent does not search for it.

This decision ends the Schema Rule. Once the Agent has tools to create, change, and cancel a Scheduled Event through the product's path, to add or replace its attachments, to record an Event Response and its Guest Registrations, and to report, an Account runs on one Agent Rule and its Prompt, and the Schema Rule is deleted with its tables and screens (ADR 0137). What it alone did today moves to the Agent Rule: Mailbox Test and Draft Rule Preview become a read-only run, Event Refresh becomes a rerun of the Agent Rule on that Source Message, and the Intake Notice goes to the Agent Rule's destinations.

## Outcome

The Schema Rule was deleted in the release that shipped migration 0037, but not quite as planned above.

- **Its tables stay.** `events.rule_id` and `rule_runs.rule_id` reference `rules`, so dropping it means rebuilding both tables in every Account D1 in one release. That is the riskiest migration this schema could take, and it buys nothing a reader needs. The rows are archived and nothing writes or runs them; they remain because Scheduled Events and Rule Runs name them as their history.
- **Event Refresh was deleted, not rerun.** It existed to overwrite Manual Overrides from a fresh extraction. The Agent identifies events by id and changes them field by field, so a person corrects an event in Google Calendar, and the next message about it changes only what that message changes.
- **Mailbox Test is a dry run with every write planned, not a read-only run.** A read-only Agent Rule binds no write tool and so plans nothing, which would show an operator nothing about what the Rule would do.
- **Inviting the roster is the Agent's choice per event.** It is an argument of `create_scheduled_event` rather than a fixed behaviour. The Prompt every Account starts with asks for it, so the Account can stop it by rewriting the Prompt.
