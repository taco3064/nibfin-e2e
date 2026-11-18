import { scopeModel } from './defect-model.mjs';
import { defectGitHub } from './defect-github.mjs';
import { defectPublisher } from './defect-publisher.mjs';
import { defectWake } from './defect-wake.mjs';

// No environment/CLI module loader. The owner-authorized host supplies private
// capabilities here. Ordinary CLI composition intentionally reports unavailable
// when these capabilities have not been installed and authorized.
export async function failureInvestigation({ configuration, model, publication,
  wake, stateDir, modelRoot, assess, publicationMode }) {
  const invoke = scopeModel(model);
  if (!publication) return Object.freeze({ model: invoke });
  const github = defectGitHub({ ...publication, configuration });
  const route = wake && publicationMode !== 'issue-events' ?
    defectWake({ ...wake, configuration }) : null;
  const publish = await defectPublisher({ configuration, stateDir, modelRoot,
    assess, github, wake: route, publicationMode });
  return Object.freeze({ model: invoke, publish });
}
