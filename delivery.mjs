import { signature } from './signature.mjs';
import { randomUUID } from 'node:crypto';

export async function deliverOne(store, destination, now = Date.now, secret) {
  const event = await store.claim(now(), randomUUID());
  if (!event) return false;
  let code = 0;
  try {
    const deliveryId = event.deliveryId || event._id;
    const headers = { 'content-type': 'application/json', 'x-event-id': deliveryId };
    if (secret) {
      const timestamp = String(Math.floor(now() / 1000));
      headers['x-relay-time'] = timestamp;
      headers['x-relay-signature'] = signature(secret, deliveryId, timestamp, event.body);
    }
    const response = await fetch(destination, { method: 'POST', body: event.body,
      headers,
      redirect: 'manual', signal: AbortSignal.timeout(5000) });
    code = response.status;
    await response.body?.cancel();
  } catch { /* A timeout or connection failure has no HTTP status. */ }
  const number = event.attempts.length + 1;
  const roundNumber = number - (event.roundStart || 0);
  const retryable = !code || code === 429 || code === 408 || code >= 500;
  const status = code >= 200 && code < 300 ? 'delivered' :
    retryable && roundNumber < 5 ? 'pending' : 'failed';
  await store.finish(event, { number, at: new Date(now()).toISOString(), httpStatus: code || null },
    status, now() + 1000 * 2 ** (roundNumber - 1));
  return true;
}


