// Ordinary workers cannot receive the protected caller, even via context.
export const prerequisite = () =>
  'Protected delivery caller and authorized stage receipt reader unavailable';
export const run = () => { throw new Error('Protected caller required'); };
export const verify = () => false;
