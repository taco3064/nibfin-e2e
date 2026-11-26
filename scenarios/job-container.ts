import type { Scenario } from '../src/types.ts';
import { Checks } from './lib/checks.ts';
import { IMAGE, imageDigest, observedFacts } from './lib/observed-facts.ts';

const SOCKET = /(podman|docker)\.sock/;

/** Proposal R6.1, R6.2, R8.2: the Job ran in a rootless, limited Podman container from the pinned digest. */
export const jobContainer: Scenario = {
  id: 'job-container',
  rules: ['R6.1', 'R6.2', 'R8.2'],
  platforms: ['linux'],
  requires: ['observed-job'],
  async run(ctx) {
    const f = observedFacts(ctx);
    const digest = imageDigest(ctx);
    const c = new Checks();
    const p = f.projection;
    c.hold('R6.1', 'a Podman container labelled with the repository and Issue ran the Shape Job', p !== undefined, p ? `image ${p.imageName}` : 'no container caught');
    c.hold('R6.2', 'Podman runs rootless', f.rootless === true, `rootless=${String(f.rootless)}`);
    const socketMounts = (p?.mounts ?? []).filter((m) => SOCKET.test(m.source) || SOCKET.test(m.destination));
    c.hold('R6.2', 'no Podman or Docker socket is mounted', p !== undefined && socketMounts.length === 0, socketMounts.map((m) => `${m.source}:${m.destination}`).join(', ') || 'none');
    const probe = f.probe;
    c.hold('R6.2', 'no Podman or Docker socket exists in the container', probe !== undefined && !probe.socket?.length, probe ? (probe.socket ?? []).join(', ') || 'none' : 'no probe block');
    c.hold('R6.2', 'DOCKER_HOST and CONTAINER_HOST are unset', probe !== undefined && !probe.env_set?.length, (probe?.env_set ?? []).join(', ') || 'none');
    const limits = p ? { memory: p.memory, cpu: Math.max(p.nanoCpus, p.cpuQuota), pids: p.pidsLimit } : undefined;
    c.hold('R6.2', 'memory, CPU and process limits are set', !!limits && limits.memory > 0 && limits.cpu > 0 && limits.pids > 0, JSON.stringify(limits ?? null));
    const ref = `${IMAGE}@${digest}`;
    c.hold('R8.2', 'the Job container runs the image by the pinned digest', p?.imageName === ref, p?.imageName ?? 'none');
    const images = f.localImages ?? [];
    const notByDigest = images.filter((i) => !i.repoDigests.includes(ref));
    c.hold('R8.2', 'every local Nibfin image is the pulled digest', images.length > 0 && notByDigest.length === 0, images.map((i) => i.repoDigests.join(' ') || i.names.join(' ')).join('; ') || 'no local image');
    c.hold('R8.2', 'the Job log names the pinned image', f.shapeLog?.imageRef?.includes(digest) === true, f.shapeLog?.imageRef ?? 'no "Nibfin image:" line');
    c.hold('R8.2', 'the Job log shows no image build', f.shapeLog !== undefined && f.shapeLog.buildOutput === undefined, f.shapeLog?.buildOutput ?? 'none');
    return c.outcome();
  },
};
