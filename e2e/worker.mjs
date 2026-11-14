import { parentPort, workerData } from 'node:worker_threads';

async function execute() {
  const scenario = await import(workerData.module);
  if (typeof scenario.run !== 'function' || typeof scenario.verify !== 'function') {
    return ['unverified', 'UNIMPLEMENTED', 'Execution and assertions are required'];
  }
  const context = Object.freeze({
    tempDir: workerData.tempDir, sources: workerData.sources,
  });
  if (scenario.prerequisite !== undefined) {
    if (typeof scenario.prerequisite !== 'function') {
      throw new Error('prerequisite must be a function');
    }
    const available = await scenario.prerequisite(context);
    if (available !== true) {
      if (typeof available !== 'string' || !available.trim()) {
        throw new Error('prerequisite must return true or a missing-resource reason');
      }
      return ['blocked', 'PREREQUISITE_MISSING', available];
    }
  }
  const actual = await scenario.run(context);
  const description = typeof scenario.describe === 'function'
    ? `; ${scenario.describe(actual)}` : '';
  if (await scenario.verify(actual, context) !== true) {
    return ['unverified', 'ASSERTIONS_INCOMPLETE',
      `verify did not confirm assertions${description}`];
  }
  return ['passed', 'ASSERTIONS_PASSED',
    `Execution and assertions completed${description}`];
}
try {
  parentPort.postMessage(await execute());
} catch (error) {
  parentPort.postMessage(['failing', 'SCENARIO_ERROR', String(error?.message ?? error)]);
}
