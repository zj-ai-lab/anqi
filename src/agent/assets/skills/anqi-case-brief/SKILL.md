---
name: anqi-case-brief
description: Establish the exact anqi case-folder context before analyzing a case and preserve deterministic deadline and task-proposal boundaries.
---

# anqi case brief

Before analyzing any case-folder material, establish the runtime context by calling
`mcp__anqi-local__case_folder_info`. Treat the returned `cwd` as the exact case
folder for this session; do not substitute a guessed path, another case name, or
user/project filesystem roots.

Use only facts returned by the anqi-owned tools and the case-folder context. Keep
facts, inferences, and recommendations distinct. Deadlines and events belong to
the deterministic anqi engine: read and explain them, but never calculate,
create, update, or delete them from model reasoning. Contacts (phone numbers,
ID numbers, and other party-identifying details) never appear in any anqi tool
result; do not ask the lawyer to supply them and do not record them yourself.

When additional work is needed, submit only a task recommendation through
`anqi_inbox_propose` for lawyer review. Do not create a task directly, and do
not create events or deadlines. A proposal is not an approval and must not be
presented as completed work.
