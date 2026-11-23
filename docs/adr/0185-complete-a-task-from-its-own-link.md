# Complete a Task from its own link

> Superseded by ADR 0198: Tasks are kept in Google Tasks, and a Task has no link.

Every Task has a link that carries a token nobody can guess. A reminder carries its Task's link. Opening the link needs no sign-in, and it opens as often as it is tapped. It shows that one Task and lets whoever holds it mark the Task completed and write a remark. Once the Task is completed or cancelled, the link only shows it.

This is how the product was meant to work: an assignee reads the reminder on LINE and finishes the work from it (ADR 0139). It was never built. No notice or reminder carries a link. The Contact Page is entered by binding a Google account through an invitation the Account issues by hand, which is the login ADR 0139 retired.

ADR 0155 chose a single-use link per Contact, which expires after its first use. It rejected a durable link per Contact, because a forwarded copy would be permanent access to everything about that person. It rejected a link per Task for the noise of issuing one. A link per Task answers both objections:

- It rides inside the reminder already being sent, so it adds no message.
- A forwarded copy exposes one Task, and the worst it allows is someone else marking that Task completed. That completion is recorded as made through the link, and the Account can reopen it.
- It reaches a Contact reachable only through a group room. Under ADR 0155 that Contact had no page at all.

This supersedes ADR 0155 for Tasks. Attendance and comments keep the Contact Page.
