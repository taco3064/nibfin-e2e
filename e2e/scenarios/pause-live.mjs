export const prerequisite = () =>
  'Protected pause caller, qualified event journal and admission evidence unavailable';
export const run = () => { throw new Error('Protected pause caller required'); };
export const verify = () => false;
