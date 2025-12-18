
// netlify/functions/state.js
// CommonJS handler using GitHub Contents API to read/write state.json.
// Env vars: GH_TOKEN, GH_OWNER, GH_REPO, GH_PATH; optional INTERNAL_KEY.

function bad(status, msg) {
  return { statusCode: status || 500, headers: { 'Content-Type': 'text/plain' }, body: msg };
}

async function readFromRepo(owner, repo, path, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }
  });
  if (r.status === 404) return { json: null, sha: null };
  if (!r.ok) throw new Error(`Repo read failed: ${r.status}`);
  const j = await r.json();
  const content = Buffer.from(j.content, 'base64').toString('utf8');
  return { json: JSON.parse(content), sha: j.sha };
}

async function writeToRepo(owner, repo, path, token, json, sha) {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const body = {
    message: 'EV state update',
    content: Buffer.from(JSON.stringify(json, null, 2), 'utf8').toString('base64')
  };
  if (sha) body.sha = sha;
  const r = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`Repo write failed: ${r.status}`);
}

function defaultState() {
  return {
    users: [],
    queue: [],
    spots: [
      { id: 'tesla-1', type: 'Tesla', label: 'Tesla #1', userId: null },
      { id: 'tesla-2', type: 'Tesla', label: 'Tesla #2', userId: null },
      { id: 'chargepoint-1', type: 'ChargePoint', label: 'ChargePoint #1', userId: null },
      { id: 'chargepoint-2', type: 'ChargePoint', label: 'ChargePoint #2', userId: null }
    ],
    lastReset: null
  };
}

function eligible(pref, type) { return pref === 'Both' || pref === type; }

exports.handler = async function (event, context) {
  try {
    const token = process.env.GH_TOKEN;
    const owner = process.env.GH_OWNER;
    const repo  = process.env.GH_REPO;
    const path  = process.env.GH_PATH || 'state.json';
    const key   = process.env.INTERNAL_KEY || '';
    if (!token || !owner || !repo) return bad(400, 'Missing env configuration');

    const method = (event.httpMethod || 'GET').toUpperCase();
    if (method === 'POST') {
      const headerKey = event.headers && (event.headers['x-key'] || event.headers['X-Key']);
      if (key && headerKey !== key) return bad(403, 'Forbidden');
    }

    let json, sha;
    ({ json, sha } = await readFromRepo(owner, repo, path, token));
    if (!json) json = defaultState();

    if (method === 'GET') {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(json)
      };
    }

    if (method !== 'POST') return bad(405, 'Method not allowed');

    const body = event.body ? JSON.parse(event.body) : {};
    const action = body.action;
    const payload = body.payload || {};

    if (action === 'addUser') {
      const name = (payload.name || '').trim();
      const pref = payload.pref || 'Both';
      if (!name) return bad(400, 'Name required');
      const nextId = Date.now();
      json.users.push({ id: nextId, name, pref });
    }
    else if (action === 'addToQueue') {
      const userId = payload.userId; if (!userId) return bad(400, 'userId required');
      const onCharger = (json.spots || []).some(s => s.userId === userId);
      const inQueue   = (json.queue || []).some(q => q.userId === userId);
      if (!onCharger && !inQueue) {
        const nextPos = (json.queue.length ? Math.max(...json.queue.map(e => e.position)) : 0) + 1;
        json.queue.push({ id: Date.now(), userId, position: nextPos });
      }
    }
    else if (action === 'removeFromQueue') {
      const userId = payload.userId;
      json.queue = json.queue.filter(q => q.userId !== userId);
    }
    else if (action === 'moveQueue') {
      const userId = payload.userId; const delta = payload.delta || 0;
      const q = json.queue.sort((a, b) => a.position - b.position);
      const idx = q.findIndex(e => e.userId === userId); const to = idx + delta;
      if (idx >= 0 && to >= 0 && to < q.length) { const A = q[idx], B = q[to]; const t = A.position; A.position = B.position; B.position = t; }
    }
    else if (action === 'endSession') {
      const spotId = payload.spotId; const spot = json.spots.find(s => s.id === spotId);
      if (spot) {
        spot.userId = null;
        const idx = json.queue.findIndex(q => {
          const u = json.users.find(x => x.id === q.userId);
          return u && eligible(u.pref, spot.type);
        });
        if (idx >= 0) { const entry = json.queue.splice(idx, 1)[0]; spot.userId = entry.userId; }
      }
    }
    else if (action === 'fillSpots') {
      for (const spot of json.spots.filter(s => !s.userId)) {
        const idx = json.queue.findIndex(q => {
          const u = json.users.find(x => x.id === q.userId);
          return u && eligible(u.pref, spot.type);
        });
        if (idx >= 0) { const entry = json.queue.splice(idx, 1)[0]; spot.userId = entry.userId; }
      }
    }
    else if (action === 'clearQueue') {
      json.queue = [];
    }
    else if (action === 'writeAll') {
      json = payload;
    }
    else {
      return bad(400, 'Unknown action');
    }

    await writeToRepo(owner, repo, path, token, json, sha);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true })
    };
  } catch (err) {
    return bad(500, `Error: ${err.message}`);
  }
};
``

