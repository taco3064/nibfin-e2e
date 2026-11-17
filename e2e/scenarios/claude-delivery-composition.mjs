import { deliveryAgent, roleChainTimeoutMs } from './claude-delivery-agent.mjs';
import { progressDriver } from './claude-delivery-progress.mjs';
import { javascriptRequests } from '../delivery-pair.mjs';

// Separate from simulated placeholder producer sources. This capability is
// supplied only by the source-owning scenario, never an ordinary run request.
export async function claudeDelivery(context, controls = {}) {
  if (!context.sources?.core?.checkout) throw new Error('PREPARED_CORE_REQUIRED');
  const agent = Object.freeze({ provider: 'claude', model: 'synthetic',
    profile: 'controlled' });
  const executor = await deliveryAgent(context);
  try {
    const driver = await progressDriver(context, executor, agent, controls);
    // The final trigger executes both role chains. Its enclosing suite call
    // must outlive that producer's entire budget, including its teardown calls.
    const pairTimeoutMs = roleChainTimeoutMs * javascriptRequests.length;
    const producerBounds = Object.freeze({ requestTimeoutMs: pairTimeoutMs,
      timeoutMs: pairTimeoutMs * 2 });
    const suiteBounds = Object.freeze({
      requestTimeoutMs: producerBounds.timeoutMs + roleChainTimeoutMs,
      timeoutMs: producerBounds.timeoutMs * 2 });
    return { agent, ...driver, producerBounds, suiteBounds,
      close: () => executor.close(),
      root: executor.root, get pending() { return executor.pending; } };
  } catch (error) { await executor.close(); throw error; }
}
