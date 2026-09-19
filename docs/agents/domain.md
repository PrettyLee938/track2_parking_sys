# Domain docs

## Layout

This project uses a single context:
- `CONTEXT.md` at the repository root for domain terminology.
- `docs/adr/` for numbered architectural decision records.

## Before exploring

Read `CONTEXT.md` and ADRs relevant to the area being explored.

If a root `CONTEXT-MAP.md` is introduced later, follow its links to
the relevant contexts and check their context-specific ADRs too.

If these files do not exist, proceed silently. Do not flag their
absence or suggest creating placeholders. The domain-modeling skill
creates them when terms or decisions are resolved.

## Vocabulary

Use the terms defined in `CONTEXT.md` when naming concepts in issues,
proposals, hypotheses, and tests. Avoid synonyms the glossary excludes.

If a needed concept is missing, reconsider whether it belongs to the
project or note the gap for domain-modeling.

## ADR conflicts

Explicitly flag proposals that contradict an existing ADR, naming the
ADR and explaining why its decision should be reconsidered.
