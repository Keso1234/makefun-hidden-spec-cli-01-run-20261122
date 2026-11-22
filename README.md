# makefun-hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Keso1234/makefun-hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Keso1234/makefun-hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one patch tool for every AI edit format: it applies a unified diff (often with wrong line numbers), SEARCH/REPLACE blocks, a V4A patch, or JSON text-editor tool calls to a tree of text files, finding the lines each edit names at the first of three matching tiers, and writes every change or none, printing what it changed or why it failed.

## Run it

```sh
node main.ts [options] [PATCH]
```

`main.ts` is Node 22 with the standard library alone. `PATCH` is a patch file, or `-` / omitted for standard input. `--format=unified|search-replace|v4a|json|auto` selects the format (auto detects it), `--check` reports what would change without writing, and `--strict` matches lines exactly. `SPEC.md` in the kit is the whole contract; `runner.ts` is the kit's trial runner, kept as it is.

Verified on the kit's practice set: 100 of 100 checks passed, practice score 1000 (unified 30, search_replace 20, v4a 20, json 15, cli 15), and the same 100 of 100 on a live practice trial (trial-0).

## License

MIT — see [LICENSE](LICENSE).

---

Built for [make.fun](https://make.fun/r/taaana65) — join with referral code `taaana65`.

<sub>Entered on [make.fun](https://make.fun/?ref=taaana65&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
