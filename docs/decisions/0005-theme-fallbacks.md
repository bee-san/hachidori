# 0005: Theme fallbacks are a direction stylesheet and graceful omission, not a switch to Default

Status: proposed (multi-language design, Phase 1)

## Context

Every theme must work in every language without per-theme work, including
themes written before languages existed. Themes build their own DOM, so core
cannot insert content into them after the fact.

## Decision

Themes declare the directions and language features they render. When a
profile's direction is not declared, the host adds `language-fallback.css`,
which isolates and start-aligns the theme's text containers
(`unicode-bidi: plaintext; text-align: start`). Language features a theme
does not render (ruby, pitch, the character view, display settings) are
omitted, as Nazeka omits pitch graphs today, and their settings are hidden
while that theme is selected.

## Options rejected

- **Render with Default when a theme lacks a feature.** The user's chosen
  theme would silently disappear for whole languages.
- **Per-field fallback rendering injected by core.** Needs each theme to
  expose slots, which is per-theme work and would not cover existing themes.
- **Require every theme to support every language.** Impossible for themes
  outside this repository and contrary to "without per-theme work".

## Consequences

- An old theme shows Arabic correctly aligned, possibly without the
  refinements a theme that declares right-to-left support gives.
- The five vendored themes declare support and implement it, so the
  fallback is only for themes from elsewhere.
