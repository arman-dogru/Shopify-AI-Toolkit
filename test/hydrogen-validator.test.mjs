// Regression tests for #39 (shopify skill, `validate.mjs --api hydrogen`).
//
// Run from the repo root with `node --test` (Node 20+), or name the file:
//   node --test test/hydrogen-validator.test.mjs
//
// Each test copies skills/shopify into a fresh temp directory, so the
// validator runs the way it does in a clean plugin install (no node_modules).
// The tests that need the npm registry skip themselves when SKIP_NETWORK_TESTS
// is set or `npm ping` fails.
import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {execFile, spawnSync} from 'node:child_process';
import {cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const run = promisify(execFile);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = {...process.env, OPT_OUT_INSTRUMENTATION: 'true'};
const isWindows = process.platform === 'win32';

// Hydrogen versions whose @shopify/hydrogen re-exports components from
// @shopify/hydrogen-react, and the 2026-10 release, which no longer does.
const REEXPORT_VERSIONS = ['2025-07', '2025-10', '2026-01', '2026-04'];
const V2026_10 = '2026-10';

const CASES = {
  moneyValid: `import {Money} from '@shopify/hydrogen';
export function P(): JSX.Element { return <Money data={{amount: '10.00', currencyCode: 'USD'}} />; }`,
  moneyInvalid: `import {Money} from '@shopify/hydrogen';
export function P(): JSX.Element { return <Money data={{amount: '10.00', currencyCode: 'USD'}} notAProp="x" />; }`,
  imageValid: `import {Image} from '@shopify/hydrogen';
export function Hero(): JSX.Element {
  return <Image data={{url: 'https://cdn.shopify.com/x.jpg', altText: 'x', width: 100, height: 100}} sizes="100vw" />;
}`,
  imageInvalid: `import {Image} from '@shopify/hydrogen';
export function Hero(): JSX.Element { return <Image data={{url: 'https://cdn.shopify.com/x.jpg'}} notAProp="x" />; }`,
  videoValid: `import {Video, MediaFile} from '@shopify/hydrogen';
export function V({v, m}: {v: any; m: any}): JSX.Element { return <><Video data={v} /><MediaFile data={m} /></>; }`,
  videoInvalid: `import {Video} from '@shopify/hydrogen';
export function V({v}: {v: any}): JSX.Element { return <Video data={v} notAProp="x" />; }`,
  localAddToCart: `import {Money} from '@shopify/hydrogen';
function AddToCartButton({children}: {children: React.ReactNode}) { return <button type="submit">{children}</button>; }
export function Buy(): JSX.Element {
  return <div><Money data={{amount: '1.00', currencyCode: 'USD'}} /><AddToCartButton>Add</AddToCartButton></div>;
}`,
  appComponentImports: `import {ProductPrice} from '~/components/ProductPrice';
import {AddToCartButton} from '~/components/AddToCartButton';
export function Buy({price}: {price: any}): JSX.Element {
  return <div><ProductPrice price={price} /><AddToCartButton lines={[]}>Add</AddToCartButton></div>;
}`,
  hydrogenReactDirect: `import {AddToCartButton} from '@shopify/hydrogen-react';
export function Buy(): JSX.Element { return <AddToCartButton variantId="gid://shopify/ProductVariant/1">Add</AddToCartButton>; }`,
  moneyFromHydrogenReact: `import {Money} from '@shopify/hydrogen-react';
export function P(): JSX.Element { return <Money data={{amount: '1.00', currencyCode: 'USD'}} />; }`,
  collectionProvider: `import {CollectionProvider} from '@shopify/hydrogen/react';
export function C({children}: {children: any}): JSX.Element { return <CollectionProvider>{children}</CollectionProvider>; }`,
};

let work;
let skill; // skill copy with dependencies installed (set by the install test)
let offlineReason;

function copySkill(name) {
  const dest = join(work, name);
  cpSync(join(repoRoot, 'skills', 'shopify'), dest, {
    recursive: true,
    filter: (src) => !src.split(/[\\/]/).includes('node_modules'),
  });
  return dest;
}

// With `shell: true` (needed for npm.cmd on Windows) arguments are joined
// unquoted, so quote anything that may contain spaces.
function npm(args) {
  const quoted = isWindows ? args.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
  return spawnSync('npm', quoted, {encoding: 'utf8', env, shell: isWindows});
}

async function validate(skillDir, caseName, version) {
  const file = join(work, `${caseName}.tsx`);
  const args = [join(skillDir, 'scripts', 'validate.mjs'), '--api', 'hydrogen', '--version', version, '--file', file, '--json'];
  let stdout;
  try {
    ({stdout} = await run(process.execPath, args, {env, cwd: work, maxBuffer: 1 << 24}));
  } catch (err) {
    if (typeof err.stdout !== 'string' || !err.stdout.trim().startsWith('{')) throw err;
    stdout = err.stdout; // the validator exits non-zero when validation fails
  }
  const [response] = JSON.parse(stdout).responses;
  const erroredComponents = new Set(response.componentValidationErrors.map((e) => e.componentName));
  return {...response, erroredComponents, raw: stdout};
}

before(() => {
  work = mkdtempSync(join(tmpdir(), 'hydrogen-validator-'));
  for (const [name, source] of Object.entries(CASES)) writeFileSync(join(work, `${name}.tsx`), `${source}\n`);
  if (process.env.SKIP_NETWORK_TESTS) offlineReason = 'SKIP_NETWORK_TESTS is set';
  else if (npm(['ping']).status !== 0) offlineReason = 'npm registry unreachable (npm ping failed)';
});
after(() => rmSync(work, {recursive: true, force: true}));

test('missing runtime dependencies produce an actionable install hint', () => {
  const noDeps = copySkill('no deps');
  const r = spawnSync(process.execPath, [join(noDeps, 'scripts', 'validate.mjs'), '--api', 'hydrogen', '--code', 'x'], {
    encoding: 'utf8',
    env,
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Cannot find package 'typescript'/);
  assert.match(r.stderr, /npm install --prefix /);
  const quoted = isWindows ? `"${noDeps}"` : `'${noDeps}'`;
  assert.ok(r.stderr.includes(quoted), `hint should name the quoted skill dir ${quoted}:\n${r.stderr}`);
});

test('declared dependencies resolve with --strict-peer-deps', (t) => {
  if (offlineReason) return t.skip(offlineReason);
  // Positive control: this check does fail on the conflict reported in #39.
  const control = join(work, 'peer-conflict-control');
  cpSync(join(repoRoot, 'skills', 'shopify', 'package.json'), join(control, 'package.json'));
  const pkg = JSON.parse(readFileSync(join(control, 'package.json'), 'utf8'));
  pkg.dependencies = {...pkg.dependencies, '@shopify/hydrogen': '2026.1.3', '@react-router/dev': '7.15.1'};
  writeFileSync(join(control, 'package.json'), JSON.stringify(pkg));
  const bad = npm(['install', '--dry-run', '--strict-peer-deps', '--no-audit', '--no-fund', '--prefix', control]);
  assert.notEqual(bad.status, 0, 'control: the #39 conflict should fail to resolve');
  assert.match(bad.stderr, /ERESOLVE/);

  const real = copySkill('peer-check');
  const r = npm(['install', '--dry-run', '--strict-peer-deps', '--no-audit', '--no-fund', '--prefix', real]);
  assert.equal(r.status, 0, `skills/shopify dependencies do not resolve:\n${r.stdout}\n${r.stderr}`);
});

test('hydrogen component validation', {timeout: 600_000}, async (t) => {
  if (offlineReason) return t.skip(offlineReason);
  skill = copySkill('with deps');
  // The hydrogen validator only needs typescript; skipping the theme-check
  // packages keeps the install small.
  const pkgPath = join(skill, 'package.json');
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.dependencies = {typescript: pkg.dependencies.typescript};
  writeFileSync(pkgPath, JSON.stringify(pkg));
  const install = npm(['install', '--no-audit', '--no-fund', '--prefix', skill]);
  assert.equal(install.status, 0, `npm install failed:\n${install.stdout}\n${install.stderr}`);

  for (const version of REEXPORT_VERSIONS) {
    await t.test(version, async (t) => {
      const [moneyOk, moneyBad, imageOk, imageBad, videoOk, videoBad, localAtc, appImports, hrDirect] = await Promise.all(
        ['moneyValid', 'moneyInvalid', 'imageValid', 'imageInvalid', 'videoValid', 'videoInvalid', 'localAddToCart', 'appComponentImports', 'hydrogenReactDirect'].map(
          (c) => validate(skill, c, version),
        ),
      );
      await t.test('valid <Money> is type-checked and passes', () => {
        assert.equal(moneyOk.result, 'success', moneyOk.raw);
        assert.deepEqual(moneyOk.validatedComponents, ['Money']);
        assert.deepEqual(moneyOk.unvalidatedComponents, []);
      });
      await t.test('invalid <Money> prop fails and is attributed to Money', () => {
        assert.equal(moneyBad.result, 'failed', moneyBad.raw);
        assert.ok(moneyBad.erroredComponents.has('Money'), moneyBad.raw);
      });
      await t.test('valid <Image> (React.ForwardRefExoticComponent) is type-checked and passes', () => {
        assert.equal(imageOk.result, 'success', imageOk.raw);
        assert.deepEqual(imageOk.validatedComponents, ['Image']);
      });
      await t.test('invalid <Image> prop fails and is attributed to Image', () => {
        assert.equal(imageBad.result, 'failed', imageBad.raw);
        assert.ok(imageBad.erroredComponents.has('Image'), imageBad.raw);
      });
      await t.test('valid <Video> (import("react").ForwardRefExoticComponent) and <MediaFile> pass', () => {
        assert.equal(videoOk.result, 'success', videoOk.raw);
        assert.deepEqual([...videoOk.validatedComponents].sort(), ['MediaFile', 'Video']);
        assert.deepEqual(videoOk.unvalidatedComponents, []);
      });
      await t.test('invalid <Video> prop fails and is attributed to Video', () => {
        assert.equal(videoBad.result, 'failed', videoBad.raw);
        assert.ok(videoBad.erroredComponents.has('Video'), videoBad.raw);
      });
      await t.test('a local AddToCartButton is not reported as validated', () => {
        assert.deepEqual(localAtc.validatedComponents, ['Money'], localAtc.raw);
        assert.ok(localAtc.unvalidatedComponents.includes('AddToCartButton'), localAtc.raw);
      });
      await t.test('~/components ProductPrice and AddToCartButton imports are not reported as validated', () => {
        assert.deepEqual(appImports.validatedComponents, [], appImports.raw);
        assert.doesNotMatch(appImports.resultDetail, /All components validated successfully/);
      });
      await t.test('hydrogen-react names that @shopify/hydrogen does not re-export are not reported as validated', () => {
        assert.deepEqual(hrDirect.validatedComponents, [], hrDirect.raw);
      });
    });
  }

  await t.test(V2026_10, async (t) => {
    const [money, moneyHr, collection] = await Promise.all(
      ['moneyValid', 'moneyFromHydrogenReact', 'collectionProvider'].map((c) => validate(skill, c, V2026_10)),
    );
    await t.test('Money from @shopify/hydrogen (no longer exported) is not reported as validated', () => {
      assert.equal(money.result, 'failed', money.raw);
      assert.deepEqual(money.validatedComponents, [], money.raw);
    });
    await t.test('Money from @shopify/hydrogen-react is not reported as a validated Hydrogen 2026-10 component', () => {
      assert.deepEqual(moneyHr.validatedComponents, [], moneyHr.raw);
    });
    await t.test('2026-10 components such as CollectionProvider are detected', {todo: 'known open: 2026.10 d.ts emit style (_$react) is not matched'}, () => {
      assert.deepEqual(collection.validatedComponents, ['CollectionProvider'], collection.raw);
    });
  });
});
