import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, chmod }
  from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { composeOperator, operatorInvestigation } from '../operator-composition.mjs';
import { operatorConfiguration } from '../operator-config.mjs';
import { operatorModel } from '../operator-model.mjs';
import { operatorEvidence } from '../operator-evidence.mjs';
import { investigationSchema } from '../operator-schema.mjs';
import { investigateFailure } from '../defect-investigation.mjs';
import { defectKey } from '../defect-policy.mjs';
import { sourceCommand } from '../source-process.mjs';

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'operator-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { version: 1, authorization: 'publish-public-defects',
    configuration: { targets: [{ repository: 'owner/repo', id: 1 }],
      assignee: { id: 2, login: 'owner' }, label: 'scope' },
    publicationMode: 'issue-events', codexExecutable: join(root, 'codex'),
    credentialFile: join(root, 'credential'), evidence: [
      { repository: 'owner/repo', kind: 'source', path: 'src/rule.mjs' },
      { repository: 'owner/repo', kind: 'callers', path: 'src/caller.mjs' },
    ] };
  for (const key of ['codexHome', 'stateDir', 'scratchRoot', 'suiteRoot']) {
    config[key] = join(root, key);
    await mkdir(config[key], { mode: 0o700 });
  }
  await writeFile(config.codexExecutable, '#!/bin/sh\nexit 1\n', { mode: 0o700 });
  await writeFile(join(config.codexHome, 'auth.json'),
    JSON.stringify({ controlled: true }), { mode: 0o600 });
  const path = join(root, 'operator.json');
  const save = () => writeFile(path, JSON.stringify(config), { mode: 0o600 });
  await save();
  return { root, config, path, save };
}

function transport() {
  const issues = [];
  const calls = [];
  const request = async (url, options) => {
    calls.push({ url, options });
    const repo = { id: 1, full_name: 'owner/repo', private: false,
      archived: false, disabled: false, default_branch: 'main' };
    let result;
    if (url.endsWith('/user')) result = { id: 2, login: 'owner', type: 'User' };
    else if (url.endsWith('/owner/repo')) result = repo;
    else if (url.includes('/assignees?')) result = [{ id: 2, login: 'owner',
      type: 'User' }];
    else if (url.includes('/labels/')) result = { name: 'scope' };
    else if (url.includes('/commits/')) result = { sha: 'c'.repeat(40) };
    else if (url.includes('/contents/')) {
      const path = url.split('/contents/')[1].split('?')[0];
      const text = 'export const controlledPublicRule = true;';
      result = { type: 'file', path, size: text.length, encoding: 'base64',
        content: Buffer.from(text).toString('base64') };
    } else if (options.method === 'POST') {
      const content = JSON.parse(options.body);
      issues.push({ ...content, assignees: [{ id: 2, login: 'owner' }],
        labels: [{ name: 'scope' }], id: 3, number: 4, node_id: 'ISSUE_4',
        state: 'open', url: 'https://api.github.com/repos/owner/repo/issues/4',
        html_url: 'https://github.com/owner/repo/issues/4' });
      result = issues.at(-1);
    } else if (url.endsWith('/issues/4')) {
      result = issues.find(row => row.number === 4);
    } else if (url.includes('/issues?')) {
      const page = Number(new URL(url).searchParams.get('page'));
      result = issues.slice((page - 1) * 100, page * 100);
    }
    else throw new Error('unexpected endpoint');
    return new Response(JSON.stringify(result));
  };
  return { request, calls, issues };
}

const proposal = evidence => ({ classification: 'implementation_defect',
  repository: 'owner/repo', ownerSource: 'src/rule.mjs', behavior: 'resume',
  changeIdentity: 'reconcile', necessaryChange: 'Reconcile before retrying.',
  title: 'Reconcile before retrying', body: 'The caller repeats a write.',
  duplicate: 'No matching work.', evidence: evidence.map(row => row.id) });

test('operator configuration requires explicit opt-in and disjoint private paths',
  async t => {
    const h = await setup(t);
    assert.equal(operatorInvestigation({ GH_TOKEN: 'present' }), undefined);
    assert.equal((await operatorConfiguration(h.path)).publicationMode, 'issue-events');
    h.config.stateDir = h.config.scratchRoot;
    await h.save();
    await assert.rejects(operatorConfiguration(h.path), /OVERLAP/);
    h.config.stateDir = join(h.root, 'stateDir');
    h.config.loader = './untrusted.mjs';
    await h.save();
    await assert.rejects(operatorConfiguration(h.path), /CONFIGURATION/);
  });

test('passing requests never resolve operator capabilities or acquire credentials',
  async () => {
    const capability = operatorInvestigation({ NIBFIN_E2E_OPERATOR: 'authorized',
      NIBFIN_E2E_OPERATOR_CONFIG: '/nonexistent/private/config.json' });
    const result = await investigateFailure({ requested: { phase: 'install' },
      phases: { install: { state: 'passed' } } }, capability);
    assert.equal(result.reason, 'REQUEST_PASSED');
  });

test('operator session inputs cannot select private publication or model roots',
  async t => {
    const h = await setup(t);
    const capabilities = operatorInvestigation({ NIBFIN_E2E_OPERATOR: 'authorized',
      NIBFIN_E2E_OPERATOR_CONFIG: h.path });
    await assert.rejects(capabilities.prepare({ stateDir: h.config.stateDir }));
    await assert.rejects(capabilities.resolve(), /SETUP_UNAVAILABLE/);
  });

test('fresh controlled model/assessment compose event publication after evidence',
  async t => {
    const h = await setup(t);
    const network = transport();
    const invocations = [];
    const command = async (file, args, options) => {
      const input = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1));
      invocations.push({ file, args, options, input });
      assert.equal(options.env.GH_TOKEN, undefined);
      assert.equal(options.env.GITHUB_TOKEN, undefined);
      assert.equal(options.env.HOME, options.cwd);
      assert(args.includes('--ignore-user-config'));
      assert(args.includes('--ignore-rules'));
      assert(args.includes('--ephemeral'));
      assert(args.includes('permissions.e2e.network.enabled=false'));
      const permissions = args.find(value =>
        value.startsWith('permissions.e2e.filesystem='));
      assert(permissions.includes(`${JSON.stringify(h.config.codexHome)} = "deny"`));
      assert(permissions.includes(`${JSON.stringify(h.config.stateDir)} = "deny"`));
      assert(!options.input.includes('ghp_controlled'));
      const result = input.finding ? { publicSafe: true, english: true,
        codeBacked: true, key: defectKey(input.finding), duplicate: 'none' } :
        { findings: [proposal(input.evidence)] };
      await writeFile(args[args.indexOf('--output-last-message') + 1],
        JSON.stringify(result));
    };
    // No publication credential exists while model capability is resolved/run.
    const capabilities = await composeOperator(await operatorConfiguration(h.path),
      { request: network.request, command });
    const result = await capabilities.model({ skill: 'Controlled Scope',
      revision: 'b'.repeat(40), symptoms: { provenance: 'controlled' } });
    assert.equal(invocations.length, 1);
    assert(network.calls.every(row => !row.options.headers.Authorization));
    await writeFile(h.config.credentialFile, 'ghp_controlled', { mode: 0o600 });
    const published = await capabilities.publish(result.findings[0], result.evidence,
      'controlled');
    assert.equal(published.state, 'associated');
    assert.equal(published.issue.url, 'https://github.com/owner/repo/issues/4');
    assert.equal(invocations.length, 2);
    assert.notEqual(invocations[0].options.cwd, invocations[1].options.cwd);
    assert.equal(invocations[1].input.symptoms, undefined);
    assert.deepEqual(invocations[1].input.issues, []);
    assert.deepEqual(await readdir(h.config.scratchRoot), []);
    assert(!JSON.stringify(invocations).includes('ghp_controlled'));
    assert.equal(network.calls.filter(row => row.options.method === 'POST').length, 1);
    const journal = await readFile(join(h.config.stateDir, 'defect-publication.json'),
      'utf8');
    assert(!journal.includes('ghp_controlled'));
  });

test('public evidence rejects non-allowlisted paths and oversized inventories',
  async t => {
    const h = await setup(t);
    const network = transport();
    const evidence = operatorEvidence(h.config, network.request);
    await assert.rejects(evidence.observe({ kind: 'source', target: '/etc/passwd' }));
    network.issues.push({ id: 1, number: 1, state: 'closed',
      title: 'x'.repeat(16001), body: 'Full content' });
    await assert.rejects(evidence.observe({ kind: 'issues', target: 'owner/repo' }),
      /EVIDENCE_LIMIT/);
    await chmod(h.path, 0o644);
    await assert.rejects(operatorConfiguration(h.path), /PATH_UNSAFE/);
  });

test('malformed output cleans scratch; unknown termination retains recovery files',
  async t => {
    const h = await setup(t);
    const malformed = operatorModel(h.config, async (file, args) => {
      await writeFile(args[args.indexOf('--output-last-message') + 1], 'invalid');
    });
    await assert.rejects(malformed({}, investigationSchema));
    assert.deepEqual(await readdir(h.config.scratchRoot), []);
    const unknown = operatorModel(h.config, async () => {
      throw Object.assign(new Error('unknown'), { terminationUnknown: true });
    });
    await assert.rejects(unknown({}, investigationSchema));
    assert.equal((await readdir(h.config.scratchRoot)).length, 1);
    // Controlled double started no process: the test owner can remove its tree.
  });

test('bounded native process fixture receives model stdin without inherited auth',
  async () => {
    const result = await sourceCommand(process.execPath, ['-e',
      'process.stdin.pipe(process.stdout);'], { env: { PATH: '/usr/bin:/bin' },
      input: 'controlled structured model input', timeoutMs: 1000, limit: 1024 });
    assert.equal(result.stdout, 'controlled structured model input');
  });

test('invalid operator setup leaves suite execution available without composition',
  async () => {
    const capabilities = operatorInvestigation({ NIBFIN_E2E_OPERATOR: 'authorized',
      NIBFIN_E2E_OPERATOR_CONFIG: '/nonexistent/private/config.json' });
    await capabilities.prepare({ stateDir: '/nonexistent/session' });
    await assert.rejects(capabilities.resolve(), /SETUP_UNAVAILABLE/);
  });

test('large metadata is omitted; full bodies across batches find unmarked work',
  async t => {
    const h = await setup(t);
    const network = transport();
    for (let index = 0; index < 104; index++) {
      network.issues.push({ id: 100 + index, number: 100 + index,
        title: `Old work ${index}`, state: index % 2 ? 'open' : 'closed',
        body: index === 0 ? null : 'Full semantic evidence. '.repeat(110),
        irrelevant: 'API metadata'.repeat(500) });
    }
    const existing = { id: 3, number: 4, node_id: 'ISSUE_4', state: 'open',
      title: 'Existing semantic work',
      body: 'Same maintained change, no marker. '.repeat(600),
      url: 'https://api.github.com/repos/owner/repo/issues/4',
      html_url: 'https://github.com/owner/repo/issues/4',
      assignees: [{ id: 2, login: 'owner' }], labels: [{ name: 'scope' }] };
    network.issues.push(existing);
    const inputs = [];
    const command = async (file, args, options) => {
      const input = JSON.parse(options.input.slice(options.input.indexOf('\n') + 1));
      inputs.push(input);
      assert(!options.input.includes('API metadata'));
      let result;
      if (!input.finding) {
        const inventory = JSON.parse(input.evidence.at(-1).text);
        assert.equal(inventory.complete, true);
        assert.equal(inventory.inventoryOnly, true);
        assert.equal(inventory.duplicateAbsenceEstablished, false);
        assert.equal(inventory.issues.length, 105);
        result = { findings: [proposal(input.evidence)] };
      } else {
        assert.equal(input.finding.evidence, undefined);
        assert(Buffer.byteLength(options.input) <= 256000);
        result = { publicSafe: true, english: true, codeBacked: true,
          key: defectKey(input.finding), duplicate: 'none' };
        if (input.issues.some(row => row.number === 4)) {
          Object.assign(result, { duplicate: 'existing', number: 4,
            existingId: existing.id, existingTitle: existing.title,
            existingBody: existing.body });
        }
      }
      await writeFile(args[args.indexOf('--output-last-message') + 1],
        JSON.stringify(result));
    };
    const capabilities = await composeOperator(await operatorConfiguration(h.path),
      { request: network.request, command });
    const result = await capabilities.model({ skill: 'Controlled Scope',
      revision: 'b'.repeat(40), symptoms: {} });
    await writeFile(h.config.credentialFile, 'ghp_controlled', { mode: 0o600 });
    const published = await capabilities.publish(result.findings[0], result.evidence,
      'controlled');
    assert.equal(published.state, 'associated');
    assert(inputs.length > 2);
    const assessed = inputs.slice(1).flatMap(input => input.issues);
    assert.deepEqual(assessed.map(row => row.body), network.issues.map(row => row.body));
    assert.equal(network.calls.filter(row => row.options.method === 'POST').length, 0);
    assert.deepEqual(await readdir(h.config.scratchRoot), []);
  });
