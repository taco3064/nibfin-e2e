// The ordinary worker never receives authorization, inventories or protected calls.
export const prerequisite = () =>
  'Protected dependency caller, admission and continuation evidence unavailable';
export const run = () => { throw new Error('Protected dependency caller required'); };
export const verify = () => false;
