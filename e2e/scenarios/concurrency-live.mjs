// Protected lifecycle composition lives in ../lifecycle.mjs; workers get no caller.
export const prerequisite = () =>
  'Protected admission, owned faults, Writer history and recovery readers unavailable';
export const run = () => { throw new Error('Protected caller required'); };
export const verify = () => false;
