// Tiny zero-dependency test framework (node tests/run-tests.mjs).

const suites = [];
let current = null;

export function suite(name, fn) {
  current = { name, tests: [] };
  suites.push(current);
  fn();
  current = null;
}

export function test(name, fn) {
  if (!current) throw new Error("test() outside suite()");
  current.tests.push({ name, fn });
}

export function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg || "expected truthy"}`);
}

export function assertEqual(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || "assertEqual"}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

export function assertClose(actual, expected, tolerance, msg) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    throw new Error(`${msg || "assertClose"}: expected ${expected} ±${tolerance}, got ${actual}`);
  }
}

export function assertGreater(actual, min, msg) {
  if (!(actual > min)) throw new Error(`${msg || "assertGreater"}: expected > ${min}, got ${actual}`);
}

export function assertLess(actual, max, msg) {
  if (!(actual < max)) throw new Error(`${msg || "assertLess"}: expected < ${max}, got ${actual}`);
}

export function assertIncludes(haystack, needle, msg) {
  if (!String(haystack).includes(needle)) {
    throw new Error(`${msg || "assertIncludes"}: ${JSON.stringify(needle)} not found in ${JSON.stringify(String(haystack).slice(0, 400))}`);
  }
}

export async function runTests({ filter } = {}) {
  let passed = 0;
  const failures = [];
  for (const s of suites) {
    for (const t of s.tests) {
      const full = `${s.name} › ${t.name}`;
      if (filter && !full.includes(filter)) continue;
      try {
        await t.fn();
        passed++;
        console.log(`  ✓ ${full}`);
      } catch (e) {
        failures.push({ name: full, error: e });
        console.log(`  ✗ ${full}\n      ${e && e.message}`);
      }
    }
  }
  console.log("");
  if (failures.length) {
    console.log(`${passed} passed, ${failures.length} FAILED`);
    for (const f of failures) {
      console.log(`\n--- ${f.name} ---\n${f.error && f.error.stack}`);
    }
    return 1;
  }
  console.log(`${passed} passed`);
  return 0;
}
