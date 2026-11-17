import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { commits, pin } from '../source-fixture.mjs';
import { sourceRepositories } from '../../source-checkout.mjs';

const expected = JSON.parse(new URL(import.meta.url).searchParams.get('expected'));

export async function run({ sources }) {
  return sources;
}
export async function verify(sources) {
  assert.deepEqual(Object.keys(sources).sort(), Object.keys(expected).sort());
  for (const [id, prepared] of Object.entries(expected)) {
    const source = sources[id];
    const repository = sourceRepositories.find(item => item.id === id);
    const identity = { ...repository, commit: commits[id], checkout: source.checkout };
    await access(source.checkout);
    const { output, ...actualIdentity } = source;
    assert.deepEqual(actualIdentity, identity);
    assert.equal(Object.hasOwn(source, 'output'), prepared, `${id} output visibility`);
    if (prepared) {
      const entry = `${source.checkout}/output`;
      assert.deepEqual(output, id === 'core' ? { archive: entry, pin } : { entry });
      await access(entry);
    }
  }
  return true;
}
