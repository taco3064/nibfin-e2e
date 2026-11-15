import { defaultTarget } from '../fixture-definition.mjs';

export const credentialConfiguration = (token, repository = defaultTarget) => ({
  secretProvider: async () => token,
  user: { actorId: 7, ownerId: 8, repository, secretRef: 'test-user' },
});
export const credentialRepository = repository => ({ id: 9, full_name: repository,
  owner: { id: 8, login: repository.split('/')[0] }, permissions: { push: true },
  archived: false, disabled: false });

export function credentialObservation(url, repository) {
  let data;
  if (url === 'https://api.github.com/user') data = { id: 7, type: 'User' };
  else if (url === `https://api.github.com/repos/${repository}`) {
    data = credentialRepository(repository);
  } else return null;
  return { status: 200, json: async () => data,
    headers: { get: key => key === 'x-oauth-scopes' ? 'repo' : null } };
}
