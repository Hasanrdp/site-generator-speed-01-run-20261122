// The entrypoint the harness runs: `node /bot/main.ts` (Node 22).
//
// It answers every case in /input/cases.json with run() from solve.js and
// writes the answers, one per case and in the cases' order, to
// /output/answers.json. Outside a container MAKEFUN_INPUT_DIR and
// MAKEFUN_OUTPUT_DIR stand in for /input and /output.
//
// V8's incremental marking is switched off before solve.js is imported, so
// all of its work runs under that flag (the rules allow an entry to tune
// V8's flags the same way the house baseline does).

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const inDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inDir, 'cases.json'), 'utf8')) as {
  id: string;
  input: unknown;
}[];

const answers: unknown[] = [];
for (let k = 0; k < cases.length; k++) answers.push(run(cases[k]!.input));

writeFileSync(join(outDir, 'answers.json'), JSON.stringify(answers));
