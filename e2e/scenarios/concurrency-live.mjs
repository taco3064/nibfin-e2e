export const prerequisite = () =>
  'Protected admission, Writer history, recovery and route readers unavailable';
export const run = () => { throw new Error('Protected caller required'); };
export const verify = () => false;
