import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { result } from './schema.mjs';

function executeWorker(scenario, tempDir, diagnostic) {
  return new Promise(resolve => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: { module: scenario.module, tempDir },
      stdout: true, stderr: true, execArgv: [],
    });
    let settled = false;
    let timer;
    const settle = async fields => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        await worker.terminate();
        resolve(result(scenario, ...fields));
      } catch (error) {
        resolve(result(scenario, 'failing', 'TERMINATION_ERROR', String(error)));
      }
    };
    // Drain output even without a consumer; scenario output never enters JSON stdout.
    for (const stream of [worker.stdout, worker.stderr]) {
      stream.on('data', chunk => {
        try { diagnostic?.(chunk); } catch { /* Diagnostics cannot grant a pass. */ }
      });
    }
    worker.once('message', fields => { void settle(fields); });
    worker.once('error', error => {
      void settle(['failing', 'WORKER_ERROR', error.message]);
    });
    worker.once('exit', code => {
      void settle(['unverified', 'EARLY_EXIT', `Worker exited without result: ${code}`]);
    });
    timer = setTimeout(() => {
      void settle(['failing', 'TIMEOUT', `Exceeded ${scenario.timeoutMs} ms`]);
    }, scenario.timeoutMs);
  });
}
export async function execute(scenario, options = {}) {
  if (scenario.policyReason) {
    return result(scenario, 'skipped-by-policy', 'POLICY', scenario.policyReason);
  }
  let tempDir;
  let outcome;
  try {
    tempDir = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'nibfin-e2e-'));
    outcome = await executeWorker(scenario, tempDir, options.diagnostic);
  } catch (error) {
    outcome = result(scenario, 'failing', 'INFRASTRUCTURE_ERROR', String(error));
  }
  if (outcome.reason.code === 'TERMINATION_ERROR') {
    outcome.reason.message += `; execution unsettled; retained ${tempDir}`;
    return outcome;
  }
  if (tempDir) {
    try {
      await (options.remove ?? rm)(tempDir, { recursive: true, force: true });
    } catch (error) {
      outcome = result(scenario, 'failing', 'CLEANUP_ERROR',
        `${outcome.reason.code}; ${tempDir}: ${error}`);
    }
  }
  return outcome;
}
