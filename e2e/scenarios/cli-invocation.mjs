// Worker inputs cannot supply the protected producer or its capabilities.
export const prerequisite = () =>
  'Protected CLI invocation capabilities and disposable host unavailable';
export const run = () => { throw new Error('Protected CLI invocation required'); };
export const verify = () => false;
