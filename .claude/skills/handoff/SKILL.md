---
name: handoff
description: Compact the current conversation into a handoff document for another agent to pick up.
argument-hint: "What will the next session be used for?"
disable-model-invocation: true
---

Write a handoff document summarising the current conversation so a fresh agent can continue the work.

Output the whole document in your reply, as one fenced Markdown block the user can copy into a new chat. This is the deliverable. Do not only save it to a file: when you run in an isolated or remote environment, the user cannot reach your file system, and a path to a file there is useless to them. Use a fence longer than any fence inside the document (for example four backticks), and never cut the document short.

Do not write the document into the current workspace.

Include a "suggested skills" section in the document, which suggests skills that the agent should invoke.

Do not duplicate content already captured in other artifacts (PRDs, plans, ADRs, issues, commits, diffs). Reference them by path or URL instead.

Redact any sensitive information, such as API keys, passwords, or personally identifiable information.

If the user passed arguments, treat them as a description of what the next session will focus on and tailor the doc accordingly.
