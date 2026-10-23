# Screenshots for the hachidori-freq pull requests

Real Chrome 152 (headless) with the unpacked extension of each checkout, over
small made-up frequency lists in the Discord report's shape: a rank-based
Jiten-like list (平均 15700) and a CC100-like list without `frequencyMode`
(平均 26700). "before" is main 58be1244.

- `popup-averages-before.png` / `popup-averages-after.png`: Show frequency
  averages and Abbreviate large numbers on. main shows Avg rank 15.7k and Avg
  frequency 26.7k; the branch shows one Avg rank 19.8k, Yomitan's harmonic
  mean of the two.
- `popup-averages-and-dictionaries-after.png`: the new Show each dictionary's
  frequencies with the averages switch.
- `popup-averages-off.png`: averages off, identical before and after.
- `settings-sort-cc100-*.png`: Reading → Frequency sorting with the CC100-like
  list chosen; the sample is inconclusive, so main sorts it highest first and
  the branch lowest first, as a rank list.
- `settings-design-frequency-*.png`: Design → Frequency labels.
- `settings-sort-labels-*.png`: Reading → Frequency sorting labels.

`scripts/` holds the scripts that took them (`shots.mjs`, `settings-shots.mjs`)
and the jsdom check of JPDB's two-number display value (`hfreq-jpdb-check.mjs`).
