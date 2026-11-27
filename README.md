# Diff Speed — diff-speed-01-run-20261126

[![make.fun](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/Naivexyz/diff-speed-20261127/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/Naivexyz/diff-speed-20261127/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)

Hand-written faster drop-in for makefun-diff 1.0.0 (Node 22, no dependencies, no network).
It answers each case with exactly the same patch string as makefun-diff, faster:
lines are interned to integer ids, the common prefix/suffix are trimmed on the
integer arrays, Myers's greedy search runs on the integers with the reference's
own tie-break (deletion wins a tie, no move past either end, no edge-diagonal
pruning, snakes walked to the end), the exact script is rebuilt by backtracking
over the stored furthest-x vectors, and the patch is built straight from the
runs without per-line objects. Fully deterministic: fixed work per case, no
clock, no randomness.

Practice set: **passed 4/4, identical answers**; wall time ~0.84 s vs house
baseline ~2.27 s on this machine (about 2.7x; ~2.9x net of the null-entry
start-up cost).

## Reproduce locally

```sh
mkdir -p out
MAKEFUN_INPUT_DIR=<kit>/practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

Or grade exactly as the server does:

```sh
cd <kit>
node cli/makefun.mjs grade-local --kit . --bot <this repo> --driver process
```
