# 0005: Fallbacks for undeclared themes act on the contract's content hooks only

Status: proposed (multi-language design, Phase 1, revision 8)

## Context

Every theme must work in every language without per-theme work, including
themes written before languages existed. Themes build their own DOM, so core
cannot insert content into them after the fact. Every theme already exposes
`.gsm-hoshidicts-definitions` (which core marks for the click-only reveal),
and every theme with a headword exposes `.gsm-hoshidicts-expression`.

## Decision

A theme declares `{directions, presentation}`. For a profile whose direction a
theme does not declare, core marks the content hooks after each render: the
headword gets the language's attributes, a definitions container holding one
dictionary (found through `data-dictionary` or `data-hoshidicts-dictionary`)
gets that dictionary's direction and `text-align: start`, one holding several
gets `unicode-bidi: plaintext` and `text-align: start` on itself and its block
descendants. Outside the
Japanese profile, core ignores character clicks from an undeclared theme and
hides the clicked-character dictionary, because such a theme may test
characters with Japanese rules. Display settings are hidden for a theme that
does not declare `presentation`.

## Options rejected

- **A stylesheet giving every popup element `unicode-bidi: plaintext` and
  `text-align: start !important`.** Measured on the vendored themes: it splits
  one definition into lines of alternating direction, turns deinflection
  trails around, leaves list markers on the wrong side and overrides deliberate
  centring.
- **Render with Default when a theme lacks a feature.** The user's chosen
  theme would silently disappear for whole languages.
- **Require every theme to support every language.** Impossible for themes
  outside this repository.

## Consequences

- An undeclared theme shows right-to-left definitions and headwords in the
  right order; the visual tests run every vendored theme with its declaration
  removed and state what this gives, nothing more.
- The five vendored themes declare support and implement it, so the fallback
  is for themes from elsewhere.
