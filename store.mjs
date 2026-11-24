export class MongoStore {
  constructor(collection) { this.events = collection; }
  async init() { await this.events.createIndex({ status: 1, due: 1 }); }
  async accept(event) {
    try { await this.events.insertOne(event); return event; }
    catch (err) { if (err.code !== 11000) throw err; }
    return this.get(event._id);
  }
  replay(id, actor) {
    const now = Date.now();
    return this.events.findOneAndUpdate({ _id: id, status: 'failed' }, [
      { $set: { status: 'pending', lease: null, due: now, roundStart: { $size: '$attempts' },
        replays: { $concatArrays: [{ $ifNull: ['$replays', []] }, [{ actor, at: new Date(now) }]] } } }
    ], { returnDocument: 'after' });
  }
  list(prefix, after, limit) {
    const range = { $gt: prefix + after, $lt: prefix + '\x7f' };
    // Older single-workspace IDs have no colon. Keep newer workspace IDs private in legacy mode.
    if (!prefix) range.$regex = '^[A-Za-z0-9_-]+$';
    return this.events.find({ _id: range }, { projection: { status: 1, count: { $size: '$attempts' } } })
      .sort({ _id: 1 }).limit(limit).toArray();
  }
  get(id) { return this.events.findOne({ _id: id }); }
  claim(now, lease) {
    return this.events.findOneAndUpdate({ status: 'pending', due: { $lte: now } },
      { $set: { lease, due: now + 30000 } }, { sort: { due: 1 }, returnDocument: 'after' });
  }
  finish(event, attempt, status, due) {
    return this.events.updateOne({ _id: event._id, lease: event.lease },
      { $set: { status, due, lease: null }, $push: { attempts: attempt } });
  }
}

// Single-process adapter for the self-contained demo.
export class DemoStore {
  events = new Map();
  accept(event) {
    if (!this.events.has(event._id)) this.events.set(event._id, event);
    return this.get(event._id);
  }
  list(prefix, after, limit) {
    return [...this.events.keys()].filter(id => id.startsWith(prefix) && id > prefix + after &&
      (prefix || !id.includes(':'))).sort().slice(0, limit).map(id => {
      const event = this.events.get(id);
      return { _id: id, status: event.status, count: event.attempts.length };
    });
  }
  get(id) { return this.events.get(id); }
  claim(now, lease) {
    const event = [...this.events.values()].find(e => e.status === 'pending' && e.due <= now);
    if (!event) return null;
    Object.assign(event, { lease, due: now + 30000 });
    return structuredClone(event);
  }
  finish(event, attempt, status, due) {
    const row = this.get(event._id);
    if (row.lease !== event.lease) return;
    row.attempts.push(attempt);
    Object.assign(row, { status, due, lease: null });
  }
}


