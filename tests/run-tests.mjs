#!/usr/bin/env node
// Zero-dependency test runner:  node tests/run-tests.mjs [filter]
//
// Loads web/tracker.js into a fake browser + fake ComfyUI (tests/harness.mjs),
// so the tracker runs unmodified against a controllable clock. No npm install,
// no jsdom, no browser needed.

import { runTests } from "./framework.mjs";
import "./core.test.mjs";
import "./panel.test.mjs";
import "./governor.test.mjs";
import "./drawing.test.mjs";

const filter = process.argv[2];
process.exitCode = await runTests({ filter });
