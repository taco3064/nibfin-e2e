import { coreFixture } from './core-fixture.mjs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const request = JSON.parse(Buffer.concat(chunks).toString());
const { mode, operation, input } = request;
const fixture = await coreFixture(process.env.E2E_CORE_ROOT, mode);
let value;
if (operation === 'observe-local-work') value = await fixture.observe();
else if (operation === 'request-local-diagnosis') value = await fixture.diagnose(input);
else throw new Error('Unsupported fixture operation');
process.stdout.write(JSON.stringify(value));
