// Protected Action observations never enter an ordinary worker.
export const prerequisite = () =>
  'Protected native Action and Core evidence readers unavailable';
export const run = () => { throw new Error('Protected Action caller required'); };
export const verify = () => false;
