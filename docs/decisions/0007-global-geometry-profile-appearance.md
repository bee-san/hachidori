# 0007: Popup size and input are global; popup appearance and content are per profile

Status: proposed (multi-language design, Phase 1, revision 7)

## Context

The owner listed "popup options" among the things a profile holds. Some
popup options describe the user's screen and hands (width, height, scale,
toolbar position, activation key, delays); others describe how a language's
entries look (theme, colours, furigana, pitch, frequency display).

## Decision

Width, height, scale, toolbar position, source highlight, Custom CSS and
JavaScript, the activation settings and keybinds are global. Theme, colours,
opacity, columns and every Design content setting are per profile.

## Options rejected

- **Everything per profile.** Resizing the popup in one language would not
  resize it in another, and the activation key would differ per language,
  which nobody asked for.
- **Everything global.** A user who prefers JL for Japanese and Default for
  English could not have both, and pitch or furigana settings would have to
  be shared with languages that have neither.

## Consequences

- A new profile starts with the edited profile's appearance, so adding a
  language does not change how the popup looks.
- Custom CSS can target a language with `[data-hd-language="ar"]` or
  `:lang(ar)`.
