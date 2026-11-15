import { randomUUID } from 'node:crypto';

export const repositorySeed = Object.freeze({
  'package.json': '{"private":true,"type":"module","scripts":{"test":' +
    '"node --test"}}\n',
  'index.mjs': 'export const greeting = name => `Hello, ${name}!`;\n',
  'index.test.mjs': "import { test } from 'node:test';\n" +
    "import { strict as assert } from 'node:assert';\n" +
    "import { greeting } from './index.mjs';\n" +
    "test('greeting', () => assert.equal(greeting('world'), 'Hello, world!'));\n",
});

export function repositoryDefinition(account, repository) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') ||
      !Number.isSafeInteger(account?.id) || account.id <= 0 ||
      !/^[a-zA-Z0-9][a-zA-Z0-9-]{0,38}$/.test(account.login ?? '')) {
    throw new Error('Disposable User account required');
  }
  const owner = randomUUID();
  return { owner, repository, account: { id: account.id, login: account.login },
    marker: `nibfin-disposable:${owner}`,
    repositories: [1, 2].map(slot => `${account.login}/nibfin-${owner}-${slot}`) };
}

export function repositoryIdentity(definition, record, native) {
  return Number.isSafeInteger(native?.id) && native.id > 0 &&
    native.full_name === record.repository &&
    native.owner?.id === definition.account.id && native.owner.type === 'User' &&
    native.owner.login === definition.account.login &&
    native.description === definition.marker && native.archived === false &&
    native.disabled === false && typeof native.default_branch === 'string' &&
    native.default_branch.length > 0 &&
    (!record.native || (record.native.id === native.id &&
      record.native.defaultBranch === native.default_branch));
}

export function repositoryNative(native) {
  return { id: native.id, fullName: native.full_name,
    owner: { id: native.owner.id, login: native.owner.login },
    defaultBranch: native.default_branch };
}
