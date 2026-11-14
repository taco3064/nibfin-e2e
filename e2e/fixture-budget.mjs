export function fixtureBudget(options = {}) {
  const limits = { requests: 80, operations: 10, timeoutMs: 30000,
    requestTimeoutMs: 5000, ...options };
  for (const value of Object.values(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 2147483647) {
      throw new Error('Positive finite fixture bounds required');
    }
  }
  const deadline = performance.now() + limits.timeoutMs;
  let requests = 0;
  let operations = 0;
  const available = () => performance.now() < deadline;
  return {
    operation() {
      if (++operations > limits.operations || !available()) {
        throw new Error('Fixture operation budget exhausted');
      }
    },
    async call(action) {
      if (++requests > limits.requests || !available()) {
        throw new Error('Fixture request budget exhausted');
      }
      const controller = new AbortController();
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(() => action(controller.signal)),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(new Error('Fixture request unavailable'));
            }, Math.min(limits.requestTimeoutMs, deadline - performance.now()));
          }),
        ]);
      } finally { clearTimeout(timer); }
    },
  };
}
