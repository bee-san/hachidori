# 0010: Packs define settings as data with a closed list of effects

Status: proposed (multi-language design, Phase 1, revision 7)

## Context

The owner wants language-specific settings defined by the pack, so a new
language can add its own (Korean hanja view, Chinese pinyin or zhuyin, Arabic
vowel marks) without editing core settings code, and they must work with
themes.

## Decision

A pack declares settings (boolean, enum or number, with a default, label and
description) whose single effect is one of: enable an optional preprocessor,
optional transforms or a variant pass in the engine; apply a display
transform to the headword or reading; or enable an optional capability.
Settings renders them from the schema, stores them per profile, and core
applies their effects. Themes see display effects through
`result.presentation`.

## Options rejected

- **Packs ship JavaScript.** Packs come from many contributors; executable
  code would need the review a theme gets, for every language.
- **Packs ship CSS.** Would collide with themes and cannot change text, which
  is what vowel marks and zhuyin need.
- **Core code per language setting.** Exactly what the owner asked to avoid.

## Consequences

- A setting that needs an effect outside the list needs a framework change,
  like a new builtin in the engine.
- Display settings never touch mined, stored or counted text, because they
  act only on `presentation`.
