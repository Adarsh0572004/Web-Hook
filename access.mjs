import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import jwt from 'jsonwebtoken';
import { rateLimit } from 'express-rate-limit';

const derive = promisify(scrypt);
const hash = text => createHash('sha256').update(text).digest('hex');
const token = () => randomBytes(32).toString('hex');
const refreshLifetime = 7 * 86400000;
export const validName = s => typeof s === 'string' && /^[a-z0-9_-]{1,60}$/.test(s);

export async function provision(db, workspace, username, role, password) {
  if (!validName(workspace) || !validName(username) || !['operator', 'viewer'].includes(role) ||
      typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('Invalid member details');
  const salt = token();
  const key = await derive(password, salt, 64);
  await db.collection('members').insertOne({ _id: workspace + ':' + username, workspace, username, role,
    salt, passwordHash: key.toString('hex') });
}

export async function workspaceAccess(db, secret, { secure = true } = {}) {
  if (!secret || Buffer.byteLength(secret) < 32) throw new Error('Set JWT_SECRET to at least 32 random bytes');
  const sessions = db.collection('sessions');
  const members = db.collection('members');
  const keys = db.collection('producerKeys');
  await sessions.createIndex({ expires: 1 }, { expireAfterSeconds: 0 });
  await sessions.createIndex({ refresh: 1 }, { unique: true });
  const cookie = { httpOnly: true, secure, sameSite: 'strict', path: '/auth' };
  function issue(res, session, refresh) {
    res.cookie('relay_refresh', refresh, { ...cookie, expires: session.expires });
    res.set('Cache-Control', 'no-store').json({ accessToken: jwt.sign({ sid: session._id }, secret,
      { algorithm: 'HS256', expiresIn: '10m', subject: session.member, issuer: 'webhook-relay' }) });
  }
  const refreshHash = req => hash((req.headers.cookie || '').split(';').map(s => s.trim())
    .find(s => /^relay_refresh=[a-f0-9]{64}$/.test(s))?.slice(14) || '');
  async function authenticate(req, res, next) {
    const bearer = req.get('authorization')?.match(/^Bearer (\S+)$/)?.[1];
    if (!bearer) return res.sendStatus(401);
    if (bearer.startsWith('wr_')) {
      const key = await keys.findOne({ _id: hash(bearer) });
      if (!key) return res.sendStatus(401);
      req.actor = { workspace: key.workspace, role: 'producer', id: key.id };
    } else {
      let claims;
      try { claims = jwt.verify(bearer, secret, { algorithms: ['HS256'], issuer: 'webhook-relay' }); }
      catch { return res.sendStatus(401); }
      const session = await sessions.findOne({ _id: claims.sid, member: claims.sub, expires: { $gt: new Date() } });
      const member = session && await members.findOne({ _id: claims.sub });
      if (!member) return res.sendStatus(401);
      req.actor = { workspace: member.workspace, role: member.role, id: member.username };
    }
    next();
  }
  function mount(app) {
    app.use('/auth', rateLimit({ windowMs: 60000, limit: 30 }));
    app.post('/auth/login', async (req, res) => {
      const { workspace, username, password } = req.body ?? {};
      if (!validName(workspace) || !validName(username) || typeof password !== 'string' || password.length > 256) return res.sendStatus(400);
      const member = await members.findOne({ _id: workspace + ':' + username });
      const supplied = await derive(password, member?.salt || 'missing-member', 64);
      if (!member || !timingSafeEqual(supplied, Buffer.from(member.passwordHash, 'hex'))) return res.sendStatus(401);
      const refresh = token();
      const session = { _id: randomUUID(), member: member._id, refresh: hash(refresh), expires: new Date(Date.now() + refreshLifetime) };
      await sessions.insertOne(session);
      issue(res, session, refresh);
    });
    app.post('/auth/refresh', async (req, res) => {
      const replacement = token();
      const session = await sessions.findOneAndUpdate({ refresh: refreshHash(req), expires: { $gt: new Date() } },
        { $set: { refresh: hash(replacement) } }, { returnDocument: 'after' });
      if (!session) return res.sendStatus(401);
      issue(res, session, replacement);
    });
    app.post('/auth/logout', async (req, res) => {
      await sessions.deleteOne({ refresh: refreshHash(req) });
      res.clearCookie('relay_refresh', cookie).sendStatus(204);
    });
    app.use('/keys', authenticate, allow('operator'));
    app.post('/keys', async (req, res) => {
      const value = 'wr_' + token();
      const id = randomUUID();
      await keys.insertOne({ _id: hash(value), id, workspace: req.actor.workspace, createdBy: req.actor.id });
      res.set('Cache-Control', 'no-store').status(201).json({ id, key: value });
    });
    app.delete('/keys/:id', async (req, res) => {
      const result = await keys.deleteOne({ id: req.params.id, workspace: req.actor.workspace });
      res.sendStatus(result.deletedCount ? 204 : 404);
    });
  }
  return { authenticate, mount };
}

export function allow(...roles) {
  return (req, res, next) => roles.includes(req.actor.role) ? next() : res.sendStatus(403);
}
