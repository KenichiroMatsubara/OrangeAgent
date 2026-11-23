---
status: accepted
---

# Think in Pi, run code in OrangeAgent, and keep Skills as Agent Skills

Every run thinks in Pi's harness, `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai` (MIT), used as they are: Pi's agent loop replaces the loop OrangeAgent wrote (`turns.ts`), and pi-ai calls every model — Claude on Anthropic's Messages API, GPT on OpenAI's Responses API, Gemini on its own API, and any other Base URL on Chat Completions — in place of OrangeAgent's adapter for each. With no provider's sandbox left, every model runs code in the environment OrangeAgent lends (`code.run`, ADR 0202), and a program it runs there reaches the run's tools through the run's Run Token at `flarechat.internal`, the container's only way out (ADR 0199). A Skill is a directory as the Agent Skills specification (agentskills.io) has it: its name is lowercase letters, digits, and hyphens, and is its directory's, `skills/{account}/{name}/{path}` in R2, its title in the words a person reads is `metadata.display-name`, a run is told every Skill as a catalog of its name, description, and location, and opens one with `activate_skill`, reads a file with `read_skill_resource`, and places the whole directory at `/skills/<name>/` with `code.run`, so a script runs from the path its SKILL.md gives. A run can also start a subagent (`agent.run`): the same loop in a context of its own, told only its task and the Skill catalog, on a model of the Account's choosing, that reads with the run's tools and plans every write without making it. That is how a run that wrote a Skill tries it as the next run will read it.

We chose this over keeping OrangeAgent's own loop and adapters because the product kept growing a harness of its own, a provider at a time, and every run's failures were ours to find. Pi is an agent harness others run in production, holds no `new Function` and needs no `nodejs_compat`, and runs in workerd unchanged. We chose to lose each provider's own environment rather than keep it beside Pi, because keeping it meant keeping OrangeAgent's adapter for each provider, which is what Pi replaces. We kept OrangeAgent's own messages (`TurnMessage`) as the run's record, so a conversation kept before Pi still reads, and Pi's own record of each answer is kept beside it and sent back as it was written. Before this, a Skill was kept under its id in a folder of its revision, read only by `skill.read`, which answered its words, and its files were placed in Claude's sandbox flattened to one name each, so a script that named its own path did not run.

This replaces ADR 0188, 0191, and 0192, and what ADR 0202 says about the environments of OpenAI's and Gemini's APIs.

## Consequences

- **Anthropic's own Skills for Word, Excel, PowerPoint, and PDF are gone.** A file of any kind is made with `code.run`, whose containers hold python-docx, openpyxl, python-pptx, reportlab, and pypdf with Japanese fonts.
- **A model reads a picture and text as it is, and any other file through `code.run`.** pi-ai hands a model no PDF or office file, so a mail's PDF is read by code; a scanned PDF is no longer read by the model's own eyes.
- **Claude's web search inside its request is gone.** `web.search` reads any page by its URL from the Worker for every model.
- **Code that calls the run's tools runs only in a container.** A Dynamic Worker is lent no Run Token.
- **Every existing Skill is renamed by migration 0064** — the product's starting Skills by what their words mean, any other by its ASCII words or by its id — and keeps its old name as its title. Its files move to its directory the first time the Worker reads it, because a migration cannot write to R2, and its SKILL.md is written with its new name; the old folders are left as they were.

## Considered and rejected

- **Pi's loop around OrangeAgent's own adapters.** It keeps every provider's sandbox and Claude's programmatic tool calling, but keeps the adapters Pi was adopted to replace.
- **Anthropic's Skills API, Claude Code or the Claude Agent SDK, Mastra, Vercel's harness, LangGraph's Deep Agents.** The first holds Skills with one provider; the rest are not open source, run a CLI in a child process Workers do not have, or assume Node.
- **Cloudflare's `agents` package's Skills.** Its reading of Skills from R2 was read as a reference only.
