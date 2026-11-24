import { createHmac, timingSafeEqual } from 'node:crypto';

export function signature(secret, id, timestamp, body) {
  return createHmac('sha256', secret).update(timestamp + '.' + id + '.').update(body).digest('hex');
}

export function validSignature(secret, id, timestamp, body, supplied) {
  if (!/^[\w-]{1,100}$/.test(id ?? '') || !/^\d{10}$/.test(timestamp ?? '') ||
      Math.abs(Date.now() / 1000 - Number(timestamp)) > 300 || !/^[a-f0-9]{64}$/.test(supplied ?? '')) return false;
  return timingSafeEqual(Buffer.from(signature(secret, id, timestamp, body), 'hex'), Buffer.from(supplied, 'hex'));
}
