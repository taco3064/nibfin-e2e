import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { result } from './schema.mjs';
import {
  invokeNative, nativeFailure,
} from './scenarios/cli-onboarding/native-command.mjs';

function executeWorker(scenario, tempDir, diagnostic, sources, env) {
  return new Promise(resolve => {
    const worker = new Worker(new URL('./worker.mjs', import.meta.url), {
      workerData: { module: scenario.module, tempDir, sources },
      stdout: true, stderr: true, execArgv: [], env,
    });
    let settled = false;
    let timer;
    const abort = new AbortController();
    let native;
    const nativeModule = new URL(
      './scenarios/cli-onboarding/contract.mjs', import.meta.url,
    ).href;
    const settle = async fields => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        abort.abort();
        await native;
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
    worker.on('message', fields => {
      if (fields?.type === 'cli-onboarding-native') {
        if (settled || native || scenario.module !== nativeModule) {
          void settle(['failing', 'INVALID_NATIVE_REQUEST', 'Invalid native request']);
          return;
        }
        // The command is parent-owned and has no worker-controlled parameters.
        native = invokeNative(tempDir, abort.signal).then(commandResult => {
          if (!settled) worker.postMessage({
            type: 'cli-onboarding-result', result: commandResult,
          });
        }, error => {
          if (!settled) worker.postMessage({
            type: 'cli-onboarding-result',
            error: nativeFailure(error),
          });
        });
        return;
      }
      void settle(fields);
    });
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
    outcome = await executeWorker(
      scenario, tempDir, options.diagnostic, options.sources, options.workerEnv,
    );
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
