import { defectEvidenceKinds } from './defect-policy.mjs';

// The facility is a protected composition capability, not a command from a run
// report. It must enforce read-only isolation and keep its authentication private.
// Only explicit read tools cross this boundary; no publisher/state is supplied.
export function scopeModel({ invoke, observe, approvePublic, timeoutMs = 60000 }) {
  if (![invoke, observe, approvePublic].every(value => typeof value === 'function') ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) {
    throw new Error('MODEL_CONFIGURATION');
  }
  return async ({ skill, revision, symptoms }) => {
    const controller = new AbortController();
    let timer;
    let active = true;
    let calls = 0;
    const evidence = new Map();
    const read = async request => {
      if (!active || ++calls > 40 || !request ||
          !defectEvidenceKinds.includes(request.kind) ||
          typeof request.target !== 'string' || request.target.length > 200) {
        throw new Error('MODEL_READ_DENIED');
      }
      // observe owns repository/path allowlists, current source and open/closed
      // Issue reads. approvePublic is an independent disclosure policy, never
      // selected by the model. Truncation alone cannot approve private content.
      const row = await observe({ kind: request.kind, target: request.target,
        signal: controller.signal });
      if (!active || !row || row.current !== true ||
          typeof row.id !== 'string' || !/^[a-zA-Z0-9._:/-]{1,200}$/.test(row.id) ||
          typeof row.text !== 'string' || Buffer.byteLength(row.text) > 16000 ||
          await approvePublic(row) !== true) throw new Error('MODEL_READ_DENIED');
      if (!active) throw new Error('MODEL_READ_DENIED');
      const safe = { id: row.id, kind: request.kind, text: row.text };
      evidence.set(row.id, safe);
      return safe;
    };
    try {
      const timeout = new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('MODEL_TIMEOUT'));
        }, timeoutMs);
      });
      const output = await Promise.race([timeout, invoke({ mode: 'Plan', skill,
        revision, symptoms, read, signal: controller.signal,
        instruction: 'Investigate read-only. Return JSON {findings:[]}. Each ' +
          'finding needs classification, repository, behavior, ownerSource, ' +
          'necessaryChange, changeIdentity, title, body, evidence IDs and duplicate ' +
          'assessment. ' +
          'Only code-backed implementation defects qualify. Reports are symptoms.',
      })]);
      const text = typeof output === 'string' ? output : JSON.stringify(output);
      if (Buffer.byteLength(text) > 64000) throw new Error('MODEL_OUTPUT_INVALID');
      const result = JSON.parse(text);
      if (!Array.isArray(result.findings) || result.findings.length > 16) {
        throw new Error('MODEL_OUTPUT_INVALID');
      }
      return { findings: result.findings, evidence: [...evidence.values()] };
    } finally {
      active = false;
      controller.abort();
      clearTimeout(timer);
    }
  };
}
