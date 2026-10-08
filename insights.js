// Writes insights.json for every published post in schedule.json.
// Env: IG_USER_ID, IG_ACCESS_TOKEN, GRAPH_VERSION (default v21.0)
// Likes and comments need instagram_basic. Reach, saves, shares need instagram_manage_insights;
// if the token lacks it those fields stay null and the page shows a dash.
const fs = require('fs');
const V = process.env.GRAPH_VERSION || 'v21.0';
const T = process.env.IG_ACCESS_TOKEN;
const get = async (path, params) => {
  const r = await fetch(`https://graph.facebook.com/${V}/${path}?${new URLSearchParams({ ...params, access_token: T })}`);
  return { ok: r.ok, json: await r.json() };
};
(async () => {
  const posts = JSON.parse(fs.readFileSync('schedule.json', 'utf8')).filter(p => p.status === 'published' && p.media_id && p.media_id !== 'dry-run');
  const out = [];
  for (const p of posts) {
    const row = { id: p.id, media_id: p.media_id, like_count: null, comments_count: null, reach: null, saved: null, shares: null };
    const base = await get(p.media_id, { fields: 'like_count,comments_count' });
    if (base.ok) { row.like_count = base.json.like_count ?? null; row.comments_count = base.json.comments_count ?? null; }
    const ins = await get(`${p.media_id}/insights`, { metric: 'reach,saved,shares' });
    if (ins.ok) for (const m of ins.json.data || []) row[m.name] = m.values?.[0]?.value ?? null;
    else console.log('insights unavailable for', p.id, ins.json.error?.message);
    out.push(row);
  }
  fs.writeFileSync('insights.json', JSON.stringify({ updated: new Date().toISOString(), posts: out }, null, 2) + '\n');
  console.log('wrote insights for', out.length, 'posts');
})();
