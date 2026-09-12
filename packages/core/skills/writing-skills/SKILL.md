---
name: writing-skills
description: Use when a task reveals a recurring, multi-step capability worth saving for future sessions — writing a new Winter skill, or improving an existing self-authored one, via skill_write.
---

# Writing Skills

A skill is a reusable PROCEDURE — a reference an agent reads before doing a repeatable, multi-step
task. It is not a fact, a preference, or something that happened once. If the thing you want to save
is "I learned X about this user/project," that's `memory_write`, not a skill. If it's "here is how to
do Y, every time Y comes up," that's a skill.

## When a skill is worth writing

Write one when ALL of the following hold:
- The task is multi-step (a single command or fact does not need a skill).
- It will recur — across this session or future ones — not a one-off fix for today's bug.
- The steps generalize: they hold regardless of the specific file/value involved this time.

Do not write a skill for: a fact about this user or project (use memory), a single tool call, or
something you are unsure will ever come up again. A skill nobody reuses is dead weight loaded into
every future session that matches its description.

## Format: what skill_write produces

`skill_write` saves the skill to **self-scope** (`~/.winter/skills/self/<name>/SKILL.md`), so it
persists across sessions and future turns can discover and load it. The store stamps the file's
frontmatter itself:

```
---
name: <slug>
description: <one line>
author: winter
---

<body>
```

You supply `name`, `description`, and `body` — the store writes the frontmatter fence and appends
your body verbatim after it. `name` must be a slug: lowercase letters, digits, and dashes only, 1–64
characters (`writing-skills`, `deploy-checklist` — not `Deploy_Checklist` or `deploy checklist`).
`description` is newline-stripped to one line — write it as a single sentence stating when the skill
applies, not what it does step-by-step (the description is what future turns scan to decide whether
to load the body at all).

Calling `skill_write` again with the same `name` overwrites the skill in place — this is how you
revise a skill after finding a gap, not a separate "update" operation.

## Quality bar

- **One capability per skill.** A skill that covers three unrelated procedures is three skills that
  happen to share a file. Split it.
- **Imperative voice.** "Run the tests before committing," not "You might want to consider running
  the tests." A skill is an instruction an agent follows, not a suggestion it weighs.
- **Concrete steps.** Name the actual command, file, or check. "Verify the build" is not a step;
  "run `bun test && bunx tsc --noEmit` from the package root" is.
- **State constraints, not narration.** Write what must (or must not) hold and why, not the story of
  how you personally discovered it. "Validate the name before any filesystem write — a rejected name
  must leave no trace" is a constraint; "I found that names could break things so I added a check"
  is narration. Future readers need the rule, not the anecdote.
- **Test the instructions by literally following them.** Before you're done, walk through the skill's
  own steps exactly as written, doing nothing it doesn't say. If you have to guess a step or fill a
  gap from outside knowledge, the skill is incomplete — fix the gap, don't rely on the reader to
  bridge it.

## Precedence note

A self-authored skill can be shadowed by a project-level or user-level skill of the same name (project
> user > self > plugin > builtin). If you're revising a *builtin* Winter skill rather than writing a
new one, `skill_write` still only writes to self-scope — the self-scope copy takes precedence over
the builtin from then on.
