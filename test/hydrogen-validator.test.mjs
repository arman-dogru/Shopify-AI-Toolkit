// Regression tests for https://github.com/Shopify/Shopify-AI-Toolkit/issues/39
// Run from the repo root with: node --test test/
//
// Each test copies skills/shopify into a fresh temp directory, so it runs the
// validator the way a clean plugin install would (no node_modules).
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {cpSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {...process.env, OPT_OUT_INSTRUMENTATION: 'true'};

const VALID_MONEY = `import {Money} from '@shopify/hydrogen';
export function Price(): JSX.Element {
  return <Money data={{amount: '10.00', currencyCode: 'USD'}} />;
}
`;
const INVALID_MONEY = `import {Money} from '@shopify/hydrogen';
export function Price(): JSX.Element {
  return <Money data={{amount: '10.00', currencyCode: 'USD'}} withoutTrailingZerosOrCurrency="yes" />;
}
`;

let work;
function copySkill(name) {
  const dest = join(work, name);
  cpSync(join(repoRoot, 'skills', 'shopify'), dest, {
    recursive: true,
    filter: (src) => !src.split(/[\\/]/).includes('node_modules'),
  });
  return dest;
}
function validate(skillDir, file, version) {
  return spawnSync(
    process.execPath,
    [join(skillDir, 'scripts', 'validate.mjs'), '--api', 'hydrogen', '--version', version, '--file', file, '--json'],
    {encoding: 'utf8', env, cwd: work},
  );
}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'hydrogen-validator-'));
  writeFileSync(join(work, 'valid.tsx'), VALID_MONEY);
  writeFileSync(join(work, 'invalid.tsx'), INVALID_MONEY);
});
after(() => rmSync(work, {recursive: true, force: true}));

test('missing runtime dependencies produce an actionable install hint', () => {
  const skill = copySkill('no-deps');
  const r = validate(skill, join(work, 'valid.tsx'), '2026-04');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Cannot find package 'typescript'/);
  assert.match(r.stderr, /npm install --prefix/);
  assert.ok(r.stderr.includes(skill), `hint should name the skill dir:\n${r.stderr}`);
});

test('clean install resolves without --legacy-peer-deps and validates Money', {timeout: 300_000}, async (t) => {
  const skill = copySkill('with-deps');
  const install = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--prefix', skill], {
    encoding: 'utf8',
    env,
    shell: process.platform === 'win32',
  });
  assert.equal(install.status, 0, `npm install failed:\n${install.stdout}\n${install.stderr}`);
  assert.doesNotMatch(install.stderr, /ERESOLVE/);

  // Versions whose @shopify/hydrogen re-exports Money from @shopify/hydrogen-react.
  for (const version of ['2025-07', '2025-10', '2026-01', '2026-04']) {
    await t.test(`${version}: valid <Money> is type-checked and passes`, () => {
      const r = validate(skill, join(work, 'valid.tsx'), version);
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /Found components: Money/);
      assert.doesNotMatch(r.stdout, /Non-Shopify components/);
    });
    await t.test(`${version}: invalid <Money> prop is rejected`, () => {
      const r = validate(skill, join(work, 'invalid.tsx'), version);
      assert.notEqual(r.status, 0, r.stdout);
      assert.match(r.stdout, /withoutTrailingZerosOrCurrency/);
    });
  }
});
