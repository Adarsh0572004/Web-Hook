import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';

let bearer = '', demo = false, pendingRefresh;
async function renew() {
  if (!pendingRefresh) pendingRefresh = fetch('/auth/refresh', { method: 'POST' }).then(async res => {
    if (!res.ok) return false;
    bearer = (await res.json()).accessToken;
    return true;
  }).finally(() => { pendingRefresh = undefined; });
  return pendingRefresh;
}
async function api(path, method = 'GET') {
  const send = () => fetch(path, { method, cache: 'no-store', headers: { Authorization: 'Bearer ' + bearer } });
  let res = await send();
  if (res.status === 401 && !demo && await renew()) res = await send();
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('session-ended'));
    throw new Error(res.status === 409 ? 'This delivery has already changed. Refresh its history.' :
      'Request failed (HTTP ' + res.status + ').');
  }
  return res.json();
}
function Login({ enter }) {
  const [local, setLocal] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    const fields = Object.fromEntries(new FormData(e.currentTarget));
    setBusy(true); setError('');
    try {
      demo = local;
      if (local) { bearer = fields.key; await api('/events?limit=1'); }
      else {
        const res = await fetch('/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields) });
        if (!res.ok) throw new Error('Sign-in failed (HTTP ' + res.status + ').');
        bearer = (await res.json()).accessToken;
      }
      enter();
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return <main className="login"><small>Webhook Relay</small><h1>Delivery console</h1>
    <form onSubmit={submit}>{local ? <label>Demo bearer key<input name="key" type="password" required /></label> :
    <><label>Workspace<input name="workspace" required /></label><label>Username<input autoComplete="username" name="username" required /></label>
    <label>Password<input type="password" autoComplete="current-password" name="password" required /></label></>}
    {error && <p role="alert">{error}</p>}<button disabled={busy}>Sign in</button></form>
    <button className="link" onClick={() => {setLocal(!local); setError('');}}>{local ? 'Use workspace account' : 'Use local demo key'}</button></main>;
}
function Status({ value }) { return <span className={'status ' + value}>{value}</span>; }
function Console({ logout, publicDemo }) {
  const [pages, setPages] = useState(['']), [selected, select] = useState(''), [list, setList] = useState(null);
  const [detail, setDetail] = useState(null), [error, setError] = useState(''), [tick, refresh] = useState(0), [busy, setBusy] = useState(false);
  const after = pages.at(-1);
  useEffect(() => {
    let active = true, timer, running = false;
    async function load() {
      if (running || !active) return;
      running = true; clearTimeout(timer);
      try {
        const [rows, event] = await Promise.all([api('/events?after=' + encodeURIComponent(after)),
          selected ? api('/events/' + encodeURIComponent(selected)) : null]);
        if (active) { setList(rows); setDetail(event); setError(''); }
      } catch (err) { if (active) setError(err.message + ' Retrying automatically.'); }
      finally { running = false; if (active) timer = setTimeout(load, 5000); }
    }
    load(); window.addEventListener('online', load);
    return () => { active = false; clearTimeout(timer); window.removeEventListener('online', load); };
  }, [after, selected, tick]);
  function page(next) { setList(null); setPages(next); select(''); setDetail(null); }
  async function replay() {
    setBusy(true);
    try { await api('/events/' + encodeURIComponent(selected) + '/replay', 'POST'); refresh(n => n + 1); }
    catch (err) { setError(err.message); } finally { setBusy(false); }
  }
  return <><header><strong>Webhook Relay</strong><span>{publicDemo ? "Public demo" : list?.workspace}</span>{!publicDemo && <button className="link" onClick={logout}>Sign out</button>}</header>
    <main><h1>Delivery console</h1>{error && <p role="alert">{error}</p>}
    <div className="grid"><section><h2>Deliveries</h2><table><thead><tr><th>Event ID</th><th>Status</th><th>Attempts</th></tr></thead>
    <tbody>{list?.items.map(e => <tr key={e.id} className={selected === e.id ? 'active' : ''}><td><button className="event" onClick={() => { select(e.id); if (selected !== e.id) setDetail(null); }}>{e.id}</button></td>
    <td><Status value={e.status}/></td><td>{e.attempts}</td></tr>)}</tbody></table>
    {!list ? <p>Loading deliveries…</p> : !list.items.length && <p>No deliveries on this page.</p>}
    <nav><button disabled={pages.length === 1} onClick={() => page(pages.slice(0,-1))}>Previous</button><span>Page {pages.length}</span>
    <button disabled={!list?.next} onClick={() => page([...pages, list.next])}>Next</button></nav></section>
    <section><h2>Delivery history</h2>{!detail ? <p>{selected ? 'Loading history…' : 'Select an event to inspect its attempts.'}</p> :
    <><h3>{detail.id}</h3><Status value={detail.status}/><ol>{detail.attempts.map(a => <li key={a.number}><b>Attempt {a.number}</b> · {a.httpStatus ? 'HTTP ' + a.httpStatus : 'Connection failure'}<br/><time>{new Date(a.at).toLocaleString()}</time></li>)}</ol>
    {!detail.attempts.length && <p>No completed attempts yet.</p>}
    {detail.replays.map((r,i) => <p key={i}>Replay requested by {r.actor} · {new Date(r.at).toLocaleString()}</p>)}
    {list?.role === 'operator' && detail.status === 'failed' && <button disabled={busy} onClick={replay}>Replay delivery</button>}</>}</section></div></main></>;
}
function App() {
  const [state, set] = useState('loading');
  useEffect(() => {
    async function open() {
      const mode = await (await fetch('/console-mode')).json();
      if (mode.publicDemo) { demo = true; set('public'); }
      else set(await renew() ? 'console' : 'login');
    }
    open().catch(() => set('login'));
    const end = () => { bearer = ''; set('login'); };
    window.addEventListener('session-ended', end);
    return () => window.removeEventListener('session-ended', end);
  }, []);
  async function logout() {
    try {
      if (pendingRefresh) await pendingRefresh;
      if (!demo && !(await fetch('/auth/logout', {method:'POST'})).ok) throw new Error();
      bearer = ''; set('login');
    } catch { window.alert('Sign-out failed. Retry when connected.'); }
  }
  if (state === 'loading') return <main>Opening console…</main>;
  return state === 'login' ? <Login enter={() => set('console')}/> : <Console logout={logout} publicDemo={state === 'public'}/>;
}
createRoot(document.querySelector('#root')).render(<App/>);


