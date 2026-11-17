import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareSources } from '../sources.mjs';
import { runPrepared } from '../runner.mjs';
import { exitCode } from '../schema.mjs';
import { commits, fakeSources, pin, put } from './source-fixture.mjs';

const action = { repository: 'taco3064/nibfin-act', commit: commits.action };
const comparisons = [
  { consumer: 'action', path: 'core-source.json', label: 'Action core-source.json',
    expected: pin, wrap: value => value, code: 'INCOMPATIBLE_CORE_SOURCE' },
  { consumer: 'cli', path: 'internal/cli/producers.json',
    label: 'CLI internal/cli/producers.json section core', expected: pin,
    wrap: value => ({ core: value, action }), code: 'INCOMPATIBLE_CORE_SOURCE' },
  { consumer: 'cli', path: 'internal/cli/producers.json',
    label: 'CLI internal/cli/producers.json section action', expected: action,
    wrap: value => ({ core: pin, action: value }),
    code: 'INCOMPATIBLE_ACTION_SOURCE' },
];
async function fixture(comparison, value, check) {
  const tempRoot = await mkdtemp(join(tmpdir(), 'compatibility-test-'));
  const fake = fakeSources();
  const acquire = async (...args) => {
    const commit = await fake.acquire(...args);
    if (args[0].id === comparison.consumer) {
      const document = comparison.wrap(value);
      await put(args[1], comparison.path, JSON.stringify(document));
    }
    return commit;
  };
  try {
    await check({ ...fake, acquire, tempRoot }, fake);
    assert.deepEqual(await readdir(tempRoot), []);
  } finally { await rm(tempRoot, { recursive: true, force: true }); }
}
function diagnostic(error, comparison, field, declared, expected) {
  assert.match(error.message, /SOURCE_PREPARATION_ERROR/);
  assert(error.message.includes(comparison.code));
  assert(error.message.includes(comparison.label));
  const repository = comparison.consumer === 'cli' ? 'gh-nibfin' : 'nibfin-act';
  assert(error.message.includes(`consumer=taco3064/${repository}@` +
    commits[comparison.consumer]));
  const producer = comparison.expected === pin ? pin : action;
  assert(error.message.includes('prepared producer=' +
    `${producer.repository}@${producer.commit}`));
  assert(error.message.includes(`${field}: declared=${declared} expected=${expected}`));
  return true;
}
for (const comparison of comparisons) {
  for (const field of Object.keys(comparison.expected)) {
    test(`${comparison.label}: ${field} identifies both source values`, async () => {
      const different = field === 'repository' ? 'other/producer' :
        'c'.repeat(comparison.expected[field].length);
      await fixture(comparison, { ...comparison.expected, [field]: different },
        async (options, fake) => {
          await assert.rejects(prepareSources(options), error =>
            diagnostic(error, comparison, field, different, comparison.expected[field]));
          assert.deepEqual(fake.prepared, ['core']);
        });
    });
    test(`${comparison.label}: missing ${field} is explicit`, async () => {
      const value = { ...comparison.expected };
      delete value[field];
      await fixture(comparison, value, async options => {
        await assert.rejects(prepareSources(options), error =>
          diagnostic(error, comparison, field, '<missing>', comparison.expected[field]));
      });
    });
  }
  for (const value of [null, {}, 'secret:/private/credential']) {
    test(`${comparison.label}: absent or malformed declaration ${typeof value}`,
      async () => {
      await fixture(comparison, value, async options => {
        await assert.rejects(prepareSources(options), error => {
          for (const field of Object.keys(comparison.expected)) {
            diagnostic(error, comparison, field, '<missing>', comparison.expected[field]);
          }
          assert(!error.message.includes('secret:'));
          return true;
        });
      });
    });
  }
}

test('unsafe values are bounded and redacted in the failed JSON report', async () => {
  const unsafe = ['https://user:password@example.test/private', '/private/token',
    { token: 'private credential' }, ['private credential'], 'x'.repeat(10000),
    'other/repo\nPRIVATE', 42, true];
  for (const value of unsafe) {
    await fixture(comparisons[1], Object.fromEntries(
      Object.keys(pin).map(field => [field, value]),
    ), async (options, fake) => {
      const document = await runPrepared([{
        id: 'never', group: 'local', title: 'Must not run', timeoutMs: 1000,
        sources: ['cli'],
        module: new URL('./fixtures/prepared.mjs', import.meta.url).href,
      }], [], { sourceOptions: options });
      const json = JSON.stringify(document);
      const decoded = JSON.parse(json);
      assert.equal(exitCode(decoded), 1);
      assert.equal(decoded.results.length, 1);
      assert.equal(decoded.results[0].outcome, 'failing');
      assert.equal(decoded.results[0].reason.code, 'SOURCE_PREPARATION_ERROR');
      assert.deepEqual(fake.prepared, ['core']);
      assert.deepEqual(decoded.errors, []);
      const message = decoded.results[0].reason.message;
      assert(message.length < 1500);
      assert(message.includes(comparisons[1].label));
      assert(!message.includes('Action core-source.json'));
      for (const field of Object.keys(pin)) {
        assert(message.includes(`${field}: declared=<invalid> expected=${pin[field]}`));
      }
      for (const secret of ['password', '/private', 'credential', 'PRIVATE']) {
        assert(!json.includes(secret));
      }
    });
  }
});

test('first incompatible declaration reports every differing field', async () => {
  await fixture(comparisons[0], {}, async options => {
    const acquire = async (...args) => {
      const commit = await options.acquire(...args);
      if (args[0].id === 'cli') await put(args[1], comparisons[1].path, {});
      return commit;
    };
    await assert.rejects(prepareSources({ ...options, acquire }), error => {
      for (const field of Object.keys(pin)) {
        diagnostic(error, comparisons[0], field, '<missing>', pin[field]);
      }
      assert(!error.message.includes('CLI'));
      const fields = Object.keys(pin).map(field => error.message.indexOf(`${field}:`));
      assert.deepEqual(fields, [...fields].sort((a, b) => a - b));
      return true;
    });
  });
});

test('a missing producers document fails as the CLI Core declaration', async () => {
  await fixture({ ...comparisons[1], wrap: () => null }, null, async options => {
    await assert.rejects(prepareSources(options), error =>
      diagnostic(error, comparisons[1], 'commit', '<missing>', pin.commit));
  });
});
