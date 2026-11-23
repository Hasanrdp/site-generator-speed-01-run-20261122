[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Hasanrdp/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Hasanrdp/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

# Faster makefun-site, byte for byte

A faster drop-in for make.fun's own makefun-site 1.0.0, for the
[make.fun site-generator-speed-01-run-20261122 competition](https://make.fun/bounty/site-generator-speed-01-run-20261122).
`solve.js` answers every case exactly as makefun-site 1.0.0 does — same front
matter rules, same template dialect, same Markdown subset, same slug rule,
same build report — and does it with as little CPU time as possible.

## How it is faster

- **Markdown in one pass.** Each body is scanned block by block straight to
  HTML, and inline marks are handled by jumping from one special character
  to the next instead of walking every character through a regex escape.
- **Templates parsed once, walked fast.** Each template is parsed once per
  case into a small node tree; the interpreter appends to an array and joins
  once per page instead of concatenating a string per node.
- **Includes that never change are rendered once.** An include whose template
  only ever reads the site, the tag list or the recent posts is rendered once
  per case (per include depth) and reused on every page — those three values
  never change between pages.
- **Cheap small things.** Slugs are cached per case, words are counted by a
  plain scan instead of a match that allocates an array of every word, and
  front matter is walked by index so a body is never split and re-joined.

Everything is deterministic: no network, no clock, no randomness, no file
access, and nothing is carried from one case to the next — every per-case
cache is built fresh inside `run()`.

## Layout

- `solve.js` — the fast drop-in. `run(input)` returns the output tree for one
  case's input, a JSON object of every path the build writes and that file's
  text, byte for byte.
- `main.ts` — the program the harness runs. It reads every case from
  `/input/cases.json`, answers each with `run`, and writes
  `/output/answers.json`.

## Run it

Node 22 or later, nothing to install:

```sh
mkdir -p /tmp/in /tmp/out
cp <cases.json> /tmp/in/cases.json
MAKEFUN_INPUT_DIR=/tmp/in MAKEFUN_OUTPUT_DIR=/tmp/out node main.ts
```

## License

MIT — see [LICENSE](LICENSE).
