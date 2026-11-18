import { run } from 'node:test';
import { launchBrowser } from './host.mjs';
import { browserCases } from './e2e-cases.mjs';

let available = false;
let browser;
try {
  browser = await launchBrowser();
  available = true;
} catch {
  process.stdout.write(JSON.stringify({ unavailable:
    'Unverified: maintained browser launch capability unavailable' }));
}
if (available) {
  await browser.close();
  const passed = [];
  let failures = false;
  for await (const event of run({ files: ['tests/browser/e2e-browser-cases.mjs'],
    concurrency: 1 })) {
    if (event.type === 'test:pass' && browserCases.includes(event.data.name)) {
      passed.push(event.data.name);
    }
    if (event.type === 'test:fail') failures = true;
  }
  process.stdout.write(JSON.stringify({ passed }));
  if (failures) process.exitCode = 1;
}
