// V7 Cloudflare Worker. Serves the app and stores per-lesson JSON progress in D1.
// No API keys are embedded in the frontend. The user's high-entropy Sync Key
// is hashed by the Worker before it is used as a database identifier.
const MAX_JSON_BYTES = 6_000_000; // inbound JSON (uncompressed); large lessons are gzipped inside D1
const MAX_STORED_BYTES = 1_800_000; // safely below Cloudflare D1 2 MB value/row cap
const NO_STORE = { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8',
  'X-Content-Type-Options': 'nosniff' };

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: NO_STORE });
}
function validLessonId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9._-]{1,80}$/.test(value);
}
function readKey(request) {
  const header = request.headers.get('Authorization') || '';
  const m = header.match(/^Bearer ([^\s]+)$/);
  if (!m || m[1].length < 20 || m[1].length > 256 || !/^[\x21-\x7e]+$/.test(m[1])) return null;
  return m[1];
}
async function keyHash(key) {
  const bytes = new TextEncoder().encode(key);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}
async function readRow(db, hash, lessonId) {
  return db.prepare('SELECT revision, data, updated_at FROM lesson_progress WHERE sync_key_hash=? AND lesson_id=?')
    .bind(hash, lessonId).first();
}
// V7.1: large lessons exceed both fetch keepalive's 64 KiB browser limit and
// D1's 2 MB-per-value cap. Store large snapshots as gzip+base64, while continuing
// to read all uncompressed V7.0 records without any SQL migration.
async function packProgress(serialized) {
  if (new TextEncoder().encode(serialized).byteLength < 60_000) return serialized;
  const compressed = new Uint8Array(await new Response(
    new Blob([serialized]).stream().pipeThrough(new CompressionStream('gzip'))
  ).arrayBuffer());
  let binary = '';
  for (let i = 0; i < compressed.length; i += 8192) {
    binary += String.fromCharCode(...compressed.subarray(i, i + 8192));
  }
  const packed = 'gz1:' + btoa(binary);
  return packed.length < serialized.length ? packed : serialized;
}
async function unpack(row) {
  if (!row) return null;
  let stored = row.data;
  if (stored.startsWith('gz1:')) {
    const bytes = Uint8Array.from(atob(stored.slice(4)), c => c.charCodeAt(0));
    stored = await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    ).text();
  }
  return { revision: Number(row.revision), data: JSON.parse(stored), updatedAt: row.updated_at };
}
async function progress(request, env) {
  if (!env.DB) return json({error:'Missing D1 binding named DB'},503);
  const key=readKey(request);
  if (!key) return json({error:'Missing or invalid Sync Key'},401);
  const hash=await keyHash(key);
  if (request.method==='GET') {
    const id=new URL(request.url).searchParams.get('lessonId');
    if (!validLessonId(id)) return json({error:'Invalid lessonId'},400);
    try { return json(await unpack(await readRow(env.DB, hash, id))); }
    catch { return json({error:'D1 unavailable or schema.sql has not been applied'},503); }
  }
  if (request.method!=='POST') return json({error:'Method not allowed'},405);
  const declaredLength=Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength>MAX_JSON_BYTES) return json({error:'Request too large'},413);
  let payload;
  try {
    const raw=await request.text();
    if (raw.length>MAX_JSON_BYTES) return json({error:'Request too large'},413);
    payload=JSON.parse(raw);
  } catch { return json({error:'Invalid JSON'},400); }
  const {lessonId,data,expectedRevision}=payload||{};
  if (!validLessonId(lessonId) || !data || typeof data !== 'object' || Array.isArray(data)
      || !Number.isSafeInteger(expectedRevision) || expectedRevision<0) {
    return json({error:'Invalid lessonId, data, or expectedRevision'},400);
  }
  if (data.lessonId && data.lessonId!==lessonId) return json({error:'Lesson ID mismatch'},400);
  const serialized=JSON.stringify(data);
  if (new TextEncoder().encode(serialized).byteLength > MAX_JSON_BYTES) {
    return json({error:'Progress exceeds the 6 MB lesson limit. Split the lesson into smaller files.'},413);
  }
  const stored=await packProgress(serialized);
  if (new TextEncoder().encode(stored).byteLength > MAX_STORED_BYTES) {
    return json({error:'Compressed progress is too large for one D1 record. Split this lesson into smaller files.'},413);
  }
  const now=new Date().toISOString();
  try {
    let result;
    if (expectedRevision===0) {
      // A first write succeeds only if no record exists.
      result=await env.DB.prepare(`INSERT OR IGNORE INTO lesson_progress
        (sync_key_hash,lesson_id,revision,data,updated_at) VALUES (?,?,1,?,?)`)
        .bind(hash,lessonId,stored,now).run();
    } else {
      // Atomic compare-and-swap: a stale device cannot overwrite a newer revision.
      result=await env.DB.prepare(`UPDATE lesson_progress
        SET revision=revision+1,data=?,updated_at=?
        WHERE sync_key_hash=? AND lesson_id=? AND revision=?`)
        .bind(stored,now,hash,lessonId,expectedRevision).run();
    }
    if (result.meta?.changes===1) return json({status:'ok',revision:expectedRevision+1});
    const latest=await readRow(env.DB,hash,lessonId);
    return json({status:'conflict',revision:latest?.revision||0,data:(await unpack(latest))?.data||null});
  } catch { return json({error:'D1 unavailable or schema.sql has not been applied'},503); }
}

export default {
  async fetch(request,env) {
    const url=new URL(request.url);
    if (url.pathname==='/api/health') {
      if (request.method!=='GET') return json({error:'Method not allowed'},405);
      try {
        const result=await env.DB.prepare('SELECT 1 FROM lesson_progress LIMIT 1').all();
        return json({status:'ok',app:'business-english-trainer',version:'7.4',database:'connected'});
      } catch {return json({status:'error',database:'not connected; run schema.sql'},503);}
    }
    if (url.pathname==='/api/progress') return progress(request,env);
    if (url.pathname.startsWith('/api/')) return json({error:'Unknown API route'},404);
    return env.ASSETS.fetch(request);
  }
};
