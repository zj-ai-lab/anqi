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
facts, inferences, and recommendations distinct.

## Recording what you find (direct writes, AI-stamped)

This session is bound to one case, and every direct write lands with an AI stamp
the lawyer can edit or revert. When case-folder material yields structured case
data, record it with the matching tool instead of describing it, asking the
lawyer to transcribe it, or wrapping it in a task:

- Party or participant details — a phone number, ID number, work unit — go to
  `anqi_contact_upsert` (update the existing contact when `anqi_case_get` shows
  one for the same person). Never turn "please record this contact info" into a
  task or proposal: you can complete the change yourself, so do it, then report
  what you changed.
- Established case facts with provenance go to `anqi_fact_add`.
- Procedural events you can date from the material go to `anqi_event_add`; the
  deterministic engine still derives deadlines from them.
- A deadline you infer yourself goes to `anqi_deadline_add` only as a draft: the
  server marks it pending review and keeps it out of reminders until the lawyer
  confirms. Never present an engine-independent deadline as authoritative.

Report every direct write in your reply so the lawyer knows what changed.

## Proposing work

`anqi_inbox_propose` is for work only the lawyer can decide or perform —
follow-ups, filings, client communication. A proposal is not an approval and
must not be presented as completed work. Do not propose work that is merely
"record X into the case": if a direct-write tool covers it, that is your job,
not the lawyer's. Use `anqi_task_add` when the lawyer explicitly asks you to put
a task on the list.
