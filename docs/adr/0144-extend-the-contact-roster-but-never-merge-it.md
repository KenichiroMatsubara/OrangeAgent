# Extend the contact roster but never merge it

An agent may create a Contact and fill a field that is empty or that it wrote itself; a field a human has touched is immutable to it. This extends to Contacts the principle the Manual Override and the Public Attachment already apply to Calendar and Drive, that automation does not overwrite a person's edit.

Merging two Contacts is withheld entirely. Deciding that a LINE handle and a Discord handle are the same person is an inference whose failure is not a data defect but a disclosure — one Contact's content delivered to another — and it defeats, from inside the roster, the rule that one Contact never learns whom else the Account addresses. The Handle Link already refuses this inference, linking a handle to a Contact by a one-time code rather than by resemblance, and that stance is kept. An agent may surface merge candidates for a human to decide, because the danger is in performing the merge, not in noticing it.

Creation stays unattended rather than proposed, because a Contact must appear the moment an unknown handle sends its first message, as LINE's webhook discovery already does, and holding that behind approval would stall inbound processing.

## Consequences

Duplicates accumulate and only humans remove them. One person reachable on two channels remains two Contacts until someone says otherwise, and may be notified twice in the meantime.
