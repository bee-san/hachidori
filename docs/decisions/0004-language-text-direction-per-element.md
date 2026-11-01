# 0004: Language text is marked per element; the popup itself stays left to right

Status: proposed (multi-language design, Phase 1)

## Context

Arabic, Yiddish and Assyrian Neo-Aramaic are written right to left. The
popup's interface (buttons, tabs, labels) is English. Most dictionaries for
these languages explain words in English, so their definitions are left to
right too.

## Decision

For a right-to-left pack, the headword, reading, matched text, sentence and
deinflection endpoints get `lang` and `dir="rtl"`; glossary containers and
input fields get `dir="auto"`. The popup element keeps the interface's
direction. Left-to-right packs get only `lang`, so a Japanese popup's markup
does not change.

## Options rejected

- **`dir="rtl"` on the whole popup.** Mirrors English buttons and tabs, puts
  English definitions of an Arabic-English dictionary into a right-to-left
  paragraph, and requires every theme's layout to be mirrored.
- **Only `dir="auto"` everywhere.** A headword whose first character is a
  digit or Latin letter would be laid out left to right.
- **No markup, trusting the Unicode bidirectional algorithm.** Correct for a
  bare Arabic word, wrong as soon as punctuation, numbers or brackets sit at
  its ends, as they do in readings, tags and deinflection trails.

## Consequences

- Themes need few changes: text containers align to `start`, and themes call
  `sourceAttributes()` where they write language text.
- Themes that do nothing still show correct text through the direction
  fallback stylesheet (decision record 0005).
