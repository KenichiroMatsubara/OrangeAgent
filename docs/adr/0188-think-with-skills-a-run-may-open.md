---
status: superseded by ADR 0203
---

# Think with Skills a run may open

A Prompt becomes a Skill: a name, a description of when it applies, and its instructions. An Agent Rule and an Automation name the Skills every one of their runs starts with, at least one and in order, and the run reads those in full. Every other Skill of the Account is listed to the run by name and description, and the run opens one with `skill.read` when it applies. An Account then adds a way of working by registering one more Skill, and every run that meets that work finds it without the run itself being rewritten. Before this, a rule or Automation read exactly one Prompt, so shared know-how was copied into each Prompt that needed it and drifted apart.

`skill.read` is offered to every run the Account itself starts, whatever its Tool Grant says. That is the one exception to "the Tool Grant is the only authorization": a Skill is the Account's own instructions to its own runs, so reading one grants no reach. An Access Token reads none, because an outside agent is not the Account; a Skill the Account publishes is offered to it as an MCP prompt instead.

The table keeps its name, `prompts`, as ADR 0157 keeps the database's vocabulary. A rule or Automation still names its first Skill in `prompt_id`, which no row can lack, and any further ones in `agent_rule_skills` and `automation_skills`.

## Consequences

- **A run's instructions are no longer fixed by its configuration alone.** Which listed Skills it opens is the model's judgement. A run records the revision of every Skill it started with. A Skill it opened along the way is recorded only in its Run Transcript, which expires.
- **A description now matters.** A Skill with none is never opened on the model's judgement, only when a rule or Automation names it.

## Considered and rejected

- **Only the Skills a rule names.** This is predictable, but it brings back the copying it was meant to end.
- **The model chooses every Skill.** This leaves a rule unable to guarantee its own core instructions, such as the intake Skill's rules for whose work a Task is.
