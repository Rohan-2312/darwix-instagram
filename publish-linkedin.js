// Publishes due, approved LinkedIn posts from linkedin.json to the Darwix AI company page.
// Types: text, carousel (PDF document), video. Run by .github/workflows/publish-linkedin.yml.
const fs = require('fs');
const FILE = 'linkedin.json';
const TOKEN = process.env.LI_ACCESS_TOKEN;
const ORG = process.env.LI_ORG_ID || '75131201';
const AUTHOR = `urn:li:organization:${ORG}`;
const VERSION = process.env.LI_VERSION || '202506';
const API = process.env.LI_API || 'https://api.linkedin.com/rest';
const H = { Authorization: `Bearer ${TOKEN}`, 'LinkedIn-Version': VERSION, 'X-Restli-Protocol-Version': '2.0.0' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function li(path, { method = 'GET', body, raw } = {}) {
  const r = await fetch(path.startsWith('http') ? path : API + path, {
    method, headers: { ...H, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : raw });
  const text = await r.text(); let j = {}; try { j = text ? JSON.parse(text) : {}; } catch {}
  if (!r.ok) {
    const msg = j.message || text.slice(0, 300) || r.statusText;
    throw new Error(r.status === 401 ? `LinkedIn token rejected (${msg}). Generate a new token and update the LI_ACCESS_TOKEN secret.` : `LinkedIn ${r.status}: ${msg}`);
  }
  return { j, headers: r.headers };
}

// Little Text Format: escape reserved characters, keep real #hashtags.
const RESERVED = /[\\|{}@\[\]()<>*_~]/g;
function ltf(s) {
  return String(s || '').replace(RESERVED, m => '\\' + m).replace(/#(?![A-Za-z0-9_])/g, '\\#');
}

async function uploadDocument(file) {
  const bytes = fs.readFileSync(file);
  const { j } = await li('/documents?action=initializeUpload', { method: 'POST', body: { initializeUploadRequest: { owner: AUTHOR } } });
  const { uploadUrl, document } = j.value;
  const r = await fetch(uploadUrl, { method: 'PUT', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/octet-stream' }, body: bytes });
  if (!r.ok) throw new Error(`Document upload failed (${r.status})`);
  for (let i = 0; i < 30; i++) { // wait until the document is processed
    const { j: d } = await li(`/documents/${encodeURIComponent(document)}`);
    if (d.status === 'AVAILABLE') return document;
    if (d.status === 'PROCESSING_FAILED') throw new Error('LinkedIn could not process the PDF.');
    await sleep(2000);
  }
  return document;
}

async function uploadVideo(file) {
  const bytes = fs.readFileSync(file);
  const { j } = await li('/videos?action=initializeUpload', { method: 'POST', body: { initializeUploadRequest: { owner: AUTHOR, fileSizeBytes: bytes.length, uploadCaptions: false, uploadThumbnail: false } } });
  const { video, uploadToken, uploadInstructions } = j.value; const etags = [];
  for (const part of uploadInstructions) {
    const r = await fetch(part.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: bytes.subarray(part.firstByte, part.lastByte + 1) });
    if (!r.ok) throw new Error(`Video upload failed (${r.status})`);
    etags.push(r.headers.get('etag'));
  }
  await li('/videos?action=finalizeUpload', { method: 'POST', body: { finalizeUploadRequest: { video, uploadToken: uploadToken || '', uploadedPartIds: etags } } });
  for (let i = 0; i < 60; i++) { // video processing can take a few minutes
    const { j: v } = await li(`/videos/${encodeURIComponent(video)}`);
    if (v.status === 'AVAILABLE') return video;
    if (v.status === 'PROCESSING_FAILED') throw new Error('LinkedIn could not process the video.');
    await sleep(10000);
  }
  throw new Error('Video is still processing. It will be retried next run.');
}

async function publish(p) {
  const post = {
    author: AUTHOR, commentary: ltf(p.caption), visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED', isReshareDisabledByAuthor: false };
  if (p.type === 'carousel') {
    if (!fs.existsSync(p.document || '')) throw new Error(`Missing ${p.document}`);
    post.content = { media: { title: (p.title || 'Darwix AI').slice(0, 400), id: await uploadDocument(p.document) } };
  } else if (p.type === 'video') {
    if (!fs.existsSync(p.video || '')) throw new Error(`Missing ${p.video}`);
    post.content = { media: { title: (p.title || 'Darwix AI').slice(0, 400), id: await uploadVideo(p.video) } };
  }
  const { headers } = await li('/posts', { method: 'POST', body: post });
  return headers.get('x-restli-id');
}

(async () => {
  if (!TOKEN) { console.error('LI_ACCESS_TOKEN is not set.'); process.exit(1); }
  const posts = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const due = posts.filter(p => p.status !== 'published' && p.approved && p.publish_at && new Date(p.publish_at) <= new Date());
  console.log(`${due.length} LinkedIn post(s) due`);
  for (const p of due) {
    try {
      p.post_urn = await publish(p); p.status = 'published'; p.published_at = new Date().toISOString(); delete p.error;
      console.log(`Published ${p.id} -> ${p.post_urn}`);
    } catch (e) { p.status = 'failed'; p.error = String(e.message || e).slice(0, 400); console.error(`Failed ${p.id}: ${p.error}`); }
    fs.writeFileSync(FILE, JSON.stringify(posts, null, 2) + '\n'); // save after each post, so a crash never loses a result
  }
})();
