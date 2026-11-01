# Crystal

Crystal is theme idea 5 in [#24](https://github.com/bee-san/hachidori-themes/issues/24):
a navy panel in a fine gold frame with scrolls in the corners and a blue crystal
crest, gold-outlined group tabs, one header per word and a framed section per
dictionary with a crystal plaque, numbered senses in gold diamonds and tag chips.
The theme was built from that mock-up and is original work under
GPL-3.0-or-later.

- **Ornaments.** The frame, corner scrolls, crest, plaques, diamonds and the book
  and star badge icons are inline SVG and CSS drawn for this theme. There is no
  game or third-party artwork.
- **Icons.** Audio, Anki, the pencil, custom actions and Close use Hachidori's
  shared outline icons (`icons.css`), as the other themes do.
- **Fonts.** None are bundled or downloaded. The stack names freely licensed
  serif families (Noto Serif and Noto Serif CJK JP under the SIL OFL 1.1, Source
  Serif 4 and Source Han Serif under the SIL OFL 1.1), then the system serifs
  Georgia, Cambria, Times New Roman, Yu Mincho, Hiragino Mincho, BIZ UDPMincho
  and MS PMincho, then `serif`.
- **Renderer.** `theme.js` builds its own DOM from lookup data with Hachidori's
  shared components (group tabs, lookup actions, audio control, frequency
  badges, pitch morae, image preview and the structured glossary renderer). Its
  per-dictionary actions, group tabs and More actions behave like Bee's Theme,
  whose Hachidori integration code in `../jl/theme.js` they follow.
