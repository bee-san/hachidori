# env.sh: toolchain for hachi-issue-658 (Node 22.23.1, CMake 3.31.6, GCC 14.3).
export PATH="$HOME/.local/share/mise/installs/node/22.23.1/bin:$HOME/.local/share/mise/installs/cmake/3.31.6/cmake-3.31.6-linux-x86_64/bin:$PATH"
G=$HOME/.local/share/mise/installs/conda-gxx-linux-64/14.3.0/bin
export CXX=$G/x86_64-conda-linux-gnu-g++ CC=$G/x86_64-conda-linux-gnu-gcc
export E=/local/home/skerraut/herd-synth3/reports/hachi-issue-658-evidence
export HC=/local/home/skerraut/herd-synth3/clones/hachi-issue-658
export HD=/local/home/skerraut/herd-synth3/clones/hachi-issue-658-hoshidicts
export DICTS=/local/home/skerraut/herd-synth3/reports/audit-hachi-fix-620-evidence/imported
export LOCKS=/local/home/skerraut/herd-vita-ocr/locks
