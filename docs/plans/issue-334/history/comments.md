# Comment index (#334)

All 29 comments were posted from the bee-san account. The original body is in [original-body.md](original-body.md), verbatim (65,485 characters, from before the rewrite). GitHub's edit history keeps it as well.

| # | When (UTC) | Comment | What it says | Where it went |
| --- | --- | --- | --- | --- |
| 00 | 2026-09-24 08:28 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5810638099) | "use js to make nazeka theme remove topbar pls" | JS themes → renderers (D1). Nazeka draws no top bar (T-32). |
| 01 | 2026-09-24 09:09 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5811238798) | "we should use js more for themes" | Renderers are JS (D1). |
| 02 | 2026-09-24 10:07 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5812092045) | Agent: body revised for JS themes; Nazeka JS prototype image | Prototype kept as evidence (evidence.md §1). The engine was superseded by c26 (D1). |
| 03 | 2026-09-24 11:37 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5813324725) | "nazeka should render no html etc just raw text, as quick as possible" | Reversed by c05, then reaffirmed as text-only by c28 (D4, D25). |
| 04 | 2026-09-24 11:39 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5813363843) | "themes should be done before we load the original UI … users custom js + css … submitted themes run before everything" | The theme *is* the UI and runs instead of Default. User CSS/JS stays on top (D5). Loaded at content-script start (T-20). |
| 05 | 2026-09-24 12:26 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5814079578) | "nazeka should follow whatever the nazeka theme is … a new Wicked theme … no processing … show how much faster" | Faithful Nazeka (T-32). Wicked (T-33). Comparison (T-52). |
| 06 | 2026-09-24 12:33 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5814181505) | "themes should also affect settings … change them by default but don't lock them" | `suggestedOptions` with Undo; `ignores` shown in Design (D10, T-43). |
| 07 | 2026-09-24 12:33 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5814188170) | "can we straight up have a yomitan theme also" | Yomitan renderer (D19, T-34). |
| 08 | 2026-09-24 12:40 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5814298846) | "generate mock UI of a theme store and post a screenshot … benchmark them all … normal vs fast buckets … no 'slow' word" | Mock-up card T-03 (not produced yet). Speed labels (D18). All themes benchmarked (D26, T-27). |
| 09 | 2026-09-24 12:55 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5814536263) | "store all of this in a branch … easy to pick up again" | Evidence branches exist, and this package is on `plan/issue-334`. |
| 10 | 2026-09-24 14:13 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5815804995) | Proposal: Kanji Atlas | T-70; API gaps → D9, T-64. |
| 11 | 2026-09-24 14:43 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5816340659) | "we should build the whole thing in a draft branch and oysg it so we can save time" | Flag-on-main delivery (D20) or an integration branch (open question 10). |
| 12 | 2026-09-24 16:01 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5817632133) | Proposal: Learner Focus | T-71; gaps → T-61, T-63, T-64. |
| 13 | 2026-09-24 16:01 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5817632143) | Proposal: Sentence Context (+ dark) | T-72; gaps → `model.source`, T-62, T-65, D8. |
| 14 | 2026-09-24 16:01 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5817634699) | Learner Focus theme.css (continuation) | T-71. |
| 15 | 2026-09-24 16:23 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5817966878) | Proposal: Tategaki / manga-vertical (+ night) | T-73; gaps → T-60, D8. |
| 16 | 2026-09-24 20:10 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5821454752) | Proposal: Geocities Y2K | T-74; gaps → update events (renderer-api.md §5). |
| 17 | 2026-09-24 20:10 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5821458937) | Proposal: Retro Terminal | T-75; gaps → T-61, Ajv strictRequired fix (themes-repo.md). |
| 18 | 2026-09-24 20:10 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5821461298) | Geocities Y2K theme.css (continuation) | T-74. |
| 19 | 2026-09-24 21:11 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5822316614) | Proposal: Tango Pet LCD | T-76; gaps → T-61, T-63; end-to-end cost note. |
| 20 | 2026-09-24 21:11 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5822319262) | Tango Pet LCD theme.css (continuation) | T-76. |
| 21 | 2026-09-25 02:19 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5825608102) | Proposal: RPG Dialogue | T-77; gaps → `ctx.schedule`, `reason`; schema drift (D7). |
| 22 | 2026-09-25 02:20 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5825617147) | Proposal: Omikuji Shrine (+ speed-label suggestion) | T-78; suggestion adopted in D18. |
| 23 | 2026-09-25 02:20 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5825619739) | Omikuji Shrine theme.css (continuation) | T-78. |
| 24 | 2026-09-25 06:01 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5827621889) | Proposal: 電子辞書 denshi-jisho | T-79; gaps → T-61, T-63. |
| 25 | 2026-09-25 06:01 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5827623571) | denshi-jisho theme.css (continuation) | T-79. |
| 26 | 2026-09-28 13:33 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5870917807) | Design update: themes own the actual popup renderer | The architecture of this plan (renderer-api.md, D1–D3, D5, D7, D9). |
| 27 | 2026-09-28 13:46 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5871156145) | Renderer control over dictionary content (rich / text / none) | D6, T-13, T-24, T-27, T-52. |
| 28 | 2026-09-28 15:00 | [link](https://github.com/bee-san/hachidori/issues/334#issuecomment-5872606542) | "i dont want themes to be js and css over the top of the normal theme … their own popup … okay to forgoe security … Nazeka … text only … all themes benchmarked" | D23–D26. It overrides the first draft of this plan: no style kind, no theme sanitiser, no JS switch. |
