// Publishes due, approved carousels from schedule.json via the Instagram Graph API.
// Env: IG_USER_ID, IG_ACCESS_TOKEN, IMAGE_BASE_URL (public base URL for repo files), GRAPH_VERSION (default v21.0), DRY_RUN=1
const fs = require('fs');
const V = process.env.GRAPH_VERSION || 'v21.0';
const BASE = `https://graph.facebook.com/${V}`;
const { IG_USER_ID, IG_ACCESS_TOKEN, IMAGE_BASE_URL } = process.env;
const DRY = process.env.DRY_RUN === '1';
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(path, params, method = 'POST') {
  const body = new URLSearchParams({ ...params, access_token: IG_ACCESS_TOKEN });
  const url = method === 'GET' ? `${BASE}/${path}?${body}` : `${BASE}/${path}`;
  const res = await fetch(url, method === 'GET' ? {} : { method, body });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`${path}: ${JSON.stringify(json.error || json)}`);
  return json;
}
async function waitFinished(id) {
  for (let i = 0; i < 30; i++) {
    const s = await api(id, { fields: 'status_code' }, 'GET');
    if (s.status_code === 'FINISHED') return;
    if (s.status_code === 'ERROR' || s.status_code === 'EXPIRED') throw new Error(`container ${id} ${s.status_code}`);
    await sleep(4000);
  }
  throw new Error(`container ${id} timed out`);
}
async function publish(post) {
  const urls = post.images.map(p => `${IMAGE_BASE_URL}/${p}`);
  if (urls.length < 2 || urls.length > 10) throw new Error('carousel needs 2-10 images');
  if (DRY) { console.log('DRY RUN would publish', post.id, urls); return 'dry-run'; }
  const children = [];
  for (const u of urls) {
    const c = await api(`${IG_USER_ID}/media`, { image_url: u, is_carousel_item: 'true' });
    await waitFinished(c.id);
    children.push(c.id);
  }
  const parent = await api(`${IG_USER_ID}/media`, { media_type: 'CAROUSEL', children: children.join(','), caption: post.caption });
  await waitFinished(parent.id);
  const out = await api(`${IG_USER_ID}/media_publish`, { creation_id: parent.id });
  return out.id;
}
(async () => {
  const file = 'schedule.json';
  const posts = JSON.parse(fs.readFileSync(file, 'utf8'));
  const now = new Date();
  let changed = false;
  for (const p of posts) {
    if (p.status === 'published' || !p.approved || new Date(p.publish_at) > now) continue;
    try {
      p.media_id = await publish(p);
      if (!DRY) { p.status = 'published'; p.published_at = new Date().toISOString(); changed = true; }
      console.log('published', p.id, p.media_id);
    } catch (e) {
      console.error('FAILED', p.id, e.message);
      p.status = 'failed'; p.error = e.message; changed = true;
    }
  }
  if (changed) fs.writeFileSync(file, JSON.stringify(posts, null, 2) + '\n');
})();
