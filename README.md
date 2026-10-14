Evidence for bee-san/hachidori#578 (PR: Queue dictionary imports instead of failing when the engine is busy).

shots/: Settings → Add dictionaries in Chrome for Testing 152 (headless). before-main is main 5d0f600c on a fresh profile;
the others are the PR branch. waiting-* show an archive waiting for another tab's imports with Cancel import
focused from the keyboard (Tab from the file chooser); cancelled-dark is after Enter on it.

scripts/: the capture, reproduction and timing scripts. Copy them into test/tmp/repro-578/ of a checkout with
test/tooling installed and Chrome installed by npm --prefix test/tooling run install:chrome, then run e.g.
REPRO_MODE=fresh node test/tmp/repro-578/repro.mjs (fresh|settled|backup; REPRO_EXTENSION=<dir> picks the extension).
