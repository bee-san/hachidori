#!/bin/bash
# e2e-step.sh <label>: only the chrome-e2e step "words only frequency and pitch
# dictionaries have" (with the setup it needs), screenshots into $E/screens/<label>.
E=/local/home/skerraut/herd-synth3/reports/hachi-issue-658-evidence
cd /local/home/skerraut/herd-synth3/clones/hachi-issue-658
export PATH=$HOME/.local/share/mise/installs/node/22.23.1/bin:$PATH
export HACHIDORI_ALLOW_NO_SANDBOX=1
export HACHIDORI_JSDOM=$PWD/test/tooling
export HACHIDORI_PUPPETEER=$(cd test/tooling && node -e 'console.log(require.resolve("puppeteer-core"))')
export HACHIDORI_CHROME=$PWD/test/tmp/browsers/chrome/linux-152.0.7977.75/chrome-linux64/chrome
mkdir -p $E/screens/$1
export HACHIDORI_METADATA_ONLY_SCREENSHOTS=$E/screens/$1
node test/make-fixture.mjs > /dev/null 2>&1
node --test-force-exit --test-reporter=spec --test-name-pattern="words only frequency and pitch dictionaries have" \
  test/chrome-e2e.mjs > $E/e2e-step-$1.log 2>&1
rc=$?
echo "e2e-step $1 rc=$rc"
exit $rc
