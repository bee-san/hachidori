# 0004: Language text is marked per element and per dictionary; the popup itself stays left to right

Status: accepted (multi-language design, Phase 1, revision 9)

## Context

Arabic, Yiddish and Assyrian Neo-Aramaic are written right to left. The
popup's interface (buttons, tabs, labels) is English. Monolingual Arabic
dictionaries explain words in Arabic; Arabic-English ones in English. Themes
compose definition text with their own Latin tags and numbers in front of the
gloss.

## Decision

Once the records have profiles, the popup element gets `dir="ltr"` and
`lang="en"`, because the reader's shadow host passes the page's direction and
language through. For a right-to-left pack, headword, matched text,
deinflection endpoints, sentence and character get `lang` and `dir="rtl"`;
readings and inputs get `dir="auto"`. Direction of definitions belongs to the
dictionary: core decides one direction per dictionary for each result from
its `targetLanguage`, and a right-to-left dictionary's block is marked in any
profile. Inside a block, a paragraph whose letters are mostly of the other
direction than the one it inherits gets its own `dir` (a majority rule
computed while rendering, shared with Anki and text mode); a dictionary whose
index declares no `targetLanguage` takes its direction from the same rule over
its glosses. After every render the theme host labels text whose nearest
`lang` is the popup's `en` or a dictionary block's default when its characters
belong to another language, line by line in text-mode definitions. Names containing
right-to-left text are isolated in inline elements. Left-to-right packs get
only `lang`, and in the single-profile shape nothing is added, so a
Japanese-only popup's markup does not change.

## Options rejected

- **`dir="rtl"` on the whole popup.** Mirrors English buttons and tabs, puts
  English definitions of an Arabic-English dictionary into a right-to-left
  paragraph, and requires every theme's layout to be mirrored.
- **`dir="auto"` on glossary containers.** The first strong character is
  often the theme's own Latin tag or number, so Arabic glosses resolve left to
  right (measured in JL and Nazeka), and one container holding several
  dictionaries takes one direction for all.
- **`unicode-bidi: plaintext` on structured-content blocks.** Takes each
  paragraph's direction from its first strong character, so an English
  paragraph that begins with an Arabic headword turns right to left, and its
  `text-align: start` overrides centring that dictionaries set on a parent
  (Jitendex's forms table in Default).
- **No markup, trusting the Unicode bidirectional algorithm.** Wrong as soon as
  punctuation, numbers or brackets sit at a word's ends, as they do in
  readings, tags, frequency labels and deinflection trails.

## Consequences

- Each vendored theme names the element that holds one dictionary's block.
- Glossary list spacing becomes logical, which changes nothing left to right.
- Japanese-only installations keep two faults they have today (a
  right-to-left page mirrors the popup; right-to-left glosses get no
  direction) until a second language is added or the owner decides to fix
  them separately.
