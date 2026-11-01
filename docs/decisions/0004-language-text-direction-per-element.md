# 0004: Language text is marked per element and per dictionary; the popup itself stays left to right

Status: proposed (multi-language design, Phase 1, revision 2)

## Context

Arabic, Yiddish and Assyrian Neo-Aramaic are written right to left. The
popup's interface (buttons, tabs, labels) is English. Monolingual Arabic
dictionaries explain words in Arabic; Arabic-English ones in English. Themes
compose definition text with their own Latin tags and numbers in front of the
gloss.

## Decision

For a right-to-left pack, headword, matched text, deinflection endpoints,
sentence and character get `lang` and `dir="rtl"`; readings, names and inputs
get `dir="auto"`. Core decides one direction per dictionary for each result
from the dictionary's `targetLanguage`, or else from the first strong
character of that dictionary's own gloss data, and themes put it on the
element holding that dictionary's block. The popup element keeps the
interface's direction. Left-to-right packs get only `lang`, and in the
single-profile shape nothing is added, so a Japanese-only popup's markup does
not change.

## Options rejected

- **`dir="rtl"` on the whole popup.** Mirrors English buttons and tabs, puts
  English definitions of an Arabic-English dictionary into a right-to-left
  paragraph, and requires every theme's layout to be mirrored.
- **`dir="auto"` on glossary containers.** The first strong character is
  often the theme's own Latin tag or number, so Arabic glosses resolve left to
  right (measured in JL and Nazeka), and one container holding several
  dictionaries takes one direction for all.
- **No markup, trusting the Unicode bidirectional algorithm.** Wrong as soon as
  punctuation, numbers or brackets sit at a word's ends, as they do in
  readings, tags, frequency labels and deinflection trails.

## Consequences

- Each vendored theme names the element that holds one dictionary's block.
- Glossary list spacing becomes logical, which changes nothing left to right.
