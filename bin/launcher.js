#!/usr/bin/env node
import { main } from '../dist/cli.js';

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    process.stderr.write(`${err instanceof Error ? err.stack || err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
