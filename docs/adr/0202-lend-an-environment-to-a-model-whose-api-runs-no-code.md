---
status: partly superseded by ADR 0203 (every model now runs code in code.run; no provider's own environment is used)
---

# Lend an environment to a model whose API runs no code

A run's model runs code where its AI Connection's API runs it: Claude in Anthropic's sandbox, GPT in OpenAI's code interpreter through the Responses API, Gemini in its code execution through its own `generateContent`, each inside its own request. Any other API, OpenRouter's among them, runs none, so OrangeAgent starts an environment of its own and lends it to the model as `code.run`. The Worker, not the model, estimates the memory the work needs from its language and the bytes of the files placed beside it, and runs it in the lightest place that fits: a Dynamic Worker of 128 MiB for small JavaScript, otherwise the smallest Cloudflare container of 256 MiB, 1 GiB, 4 GiB, or 12 GiB that covers the estimate, one container class per size because Cloudflare fixes a container's instance type by its class, and one size larger, once, when the code ran out of memory. OpenAI's container is made with the memory the same estimate names. The environments OrangeAgent starts reach no network, start empty for every call, and are destroyed when it ends.

We chose this over OpenRouter's own hosted shell (`openrouter:shell`), which runs any model's commands in OpenRouter's sandbox: it takes no memory size, it is spoken only on OpenRouter's Responses and Messages APIs, and it would put the files and the bill of a run with yet another provider, for one host only. Cloudflare's containers keep the run's files and code in OrangeAgent's own account, take a memory size, and serve every API that runs no code alike. ADR 0199 said OrangeAgent starts no environment of its own; it now does, though the Run Token still goes to none of them, since they reach no network and their code calls none of the run's tools.

## Consequences

Four container classes are Durable Object classes with a migration of their own, and every deploy builds the image in `apps/worker/workbench/Dockerfile`, so the release needs Docker where `npm run deploy:cloudflare` runs. Reading the protocol from the host now sends a Base URL on `api.openai.com` through the Responses API and one on `generativelanguage.googleapis.com` through `generateContent`, the legacy Gemini OpenAI-compatible URL included, rather than through Chat Completions.
