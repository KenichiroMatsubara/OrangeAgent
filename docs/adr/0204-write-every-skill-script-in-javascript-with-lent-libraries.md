---
status: accepted
---

# Write every Skill's script in JavaScript, with libraries the environment lends

A script a Skill carries is JavaScript, an Office file's and a PDF's included, and no Skill's script is Python. The Worker lends a run's JavaScript the libraries an Office file needs — exceljs, docx, pptxgenjs, pdf-lib, fflate, and @xmldom/xmldom — by their npm names, as a container's image holds Python's: each is bundled once into a dependency-free module under `apps/worker/lent/` (`npm run lent`), handed to a Dynamic Worker as a module beside the code, with each import of it pointed at that module, and to a container as a package in `/node_modules`, and only to a run whose code or Skill script imports it. Where an official Skill, such as the Office Skills of Anthropic's that Pi's documentation points to, is written in Python, FlareChat writes its JavaScript in its place; every Account is given office-files, which does so for docx, xlsx, pptx, and PDF.

We chose JavaScript for every script because `code.run` runs JavaScript in a Dynamic Worker, which starts in milliseconds, costs nothing beside the request, and calls the run's tools through an RPC stub, while Python goes to a container that takes seconds to start. A filled form keeps every part it did not need to change only when its XML is changed in place, which fflate and xmldom do as well as Python's zipfile and lxml, and what a library cannot do in JavaScript — LibreOffice's conversion and recalculation — the container's image could not do either. We chose to lend the libraries from the environment rather than copy them into each Skill because a copy of 2 MB in every Account's R2 would drift from one Account to the next, would leave every Account made before it without one, and would count against the isolate's estimate in every Skill that carried it.

## Consequences

- **A library once lent is a contract with every Account's scripts.** Removing one, or a version that changes its API, breaks a script that imports it; a new library is added to `lent.ts` and bundled, never put in a Skill.
- **The container keeps its Python for code a run writes for itself**, such as a chart with matplotlib, and `code.run` still accepts Python; a Skill's Python script that an Account already holds is rewritten in JavaScript rather than kept.
- **A form's formulas are not recalculated.** Their saved results stay as they were until Excel opens the file; this was already so, because the container has no LibreOffice.
- **A new PDF cannot set Japanese**, because pdf-lib's standard fonts have no Japanese glyphs and a Japanese font is too large for the isolate; such a document is made as docx or xlsx.

## Considered and rejected

- **Each Office library as `.mjs` files in an Office Skill's directory.** Every Account would hold its own copy, the Skill would have to be named in every `code.run` that fills a file, and an Account made before it would hold none.
- **Python for Office files only.** It keeps two languages for one kind of script and sends every form a run fills to a container.
