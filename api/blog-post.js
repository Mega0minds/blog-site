/**
 * Vercel serverless: serves the blog post page with Open Graph meta from Firestore.
 * Reads blog-post.template.html (repo root). Public URL stays /blog-post.html (rewrite); do not deploy a static blog-post.html or it overrides this route.
 * Set env FIREBASE_SERVICE_ACCOUNT to the JSON of a Firebase service account (Firestore read).
 */
const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const MARKER = '<!-- __SOCIAL_HEAD_INJECT__ -->';

function escapeAttr(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, ' ');
}

/** Title shown in WhatsApp / OG: strip feed junk (e.g. " .... Revealing…") and cap length. */
function socialPreviewTitle(raw, maxLen = 100) {
  let t = String(raw || '').trim().replace(/\s+/g, ' ');
  t = t.replace(/\s+\.{2,}.*$/u, '').trim();
  if (!t) return String(raw || 'News Connect').trim().slice(0, maxLen);
  if (t.length <= maxLen) return t;
  const cut = t.slice(0, maxLen);
  const sp = cut.lastIndexOf(' ');
  return `${sp > 35 ? cut.slice(0, sp) : cut}…`.trim();
}

/** Body blurb for OG: do not repeat the headline; trim to one card-friendly line. */
function socialPreviewDescription(body, rawTitle, ogTitle, maxLen = 160) {
  let plain = String(body || '').replace(/\s+/g, ' ').trim();
  if (!plain) return 'Read on News Connect.';
  const prefixes = [String(rawTitle || '').trim(), String(ogTitle || '').trim()].filter((p) => p.length >= 8);
  for (const p of prefixes) {
    if (plain.toLowerCase().startsWith(p.toLowerCase())) {
      plain = plain.slice(p.length).trim().replace(/^[\s.:;\-–—|]+/, '');
    }
  }
  if (!plain) return 'Read on News Connect.';
  if (plain.length > maxLen) {
    let cut = plain.slice(0, maxLen - 1);
    const sp = cut.lastIndexOf(' ');
    cut = sp > 30 ? cut.slice(0, sp) : cut;
    plain = `${cut.trim()}…`;
  }
  return plain;
}

function absoluteImageUrl(origin, imageUrl) {
  const base = origin.endsWith('/') ? origin.slice(0, -1) : origin;
  const def = `${base}/img/home.png`;
  if (!imageUrl || !String(imageUrl).trim()) return def;
  const u = String(imageUrl).trim();
  if (/^https?:\/\//i.test(u)) return u;
  if (u.startsWith('/')) return `${base}${u}`;
  return `${base}/${u}`;
}

function articlePublishedIso(data) {
  if (!data) return null;
  const ts = data.createdAt;
  if (ts && typeof ts.toDate === 'function') {
    try {
      return ts.toDate().toISOString();
    } catch {
      /* ignore */
    }
  }
  if (data.createdDate) {
    const d = new Date(data.createdDate);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

function buildSocialHead(origin, postId, data) {
  const hasPost = data && data.title;
  const rawTitle = hasPost ? String(data.title) : 'News Connect';
  const ogTitle = socialPreviewTitle(rawTitle);
  const desc = hasPost
    ? socialPreviewDescription(data.body, rawTitle, ogTitle)
    : 'Read the latest on News Connect.';
  const image = absoluteImageUrl(origin, hasPost && data.imageUrl ? data.imageUrl : '');

  const pathWithQuery =
    postId && String(postId).trim()
      ? `/blog-post.html?id=${encodeURIComponent(String(postId).trim())}`
      : '/blog-post.html';
  const canonical = `${origin.replace(/\/$/, '')}${pathWithQuery}`;

  const publishedIso = articlePublishedIso(data);
  const publishedMeta = publishedIso
    ? `<meta property="article:published_time" content="${escapeAttr(publishedIso)}">`
    : '';

  return `
    <link rel="canonical" href="${escapeAttr(canonical)}">
    <meta name="description" content="${escapeAttr(desc)}">
    <meta property="og:site_name" content="${escapeAttr('News Connect')}">
    <meta property="og:locale" content="en_US">
    <meta property="og:type" content="article">
    <meta property="og:url" content="${escapeAttr(canonical)}">
    <meta property="og:title" content="${escapeAttr(ogTitle)}">
    <meta property="og:description" content="${escapeAttr(desc)}">
    <meta property="og:image" content="${escapeAttr(image)}">
    <meta property="og:image:secure_url" content="${escapeAttr(image)}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="${escapeAttr(ogTitle)}">
    ${publishedMeta}
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:url" content="${escapeAttr(canonical)}">
    <meta name="twitter:title" content="${escapeAttr(ogTitle)}">
    <meta name="twitter:description" content="${escapeAttr(desc)}">
    <meta name="twitter:image" content="${escapeAttr(image)}">
    <meta name="twitter:image:alt" content="${escapeAttr(ogTitle)}">
  `.trim();
}

function ensureAdmin() {
  if (admin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) return;
  const cred = JSON.parse(raw);
  admin.initializeApp({ credential: admin.credential.cert(cred) });
}

module.exports = async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.status(405).send('Method Not Allowed');
    return;
  }

  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const origin = `${proto}://${host}`;

  const blogPath = path.join(process.cwd(), 'blog-post.template.html');
  let template;
  try {
    template = fs.readFileSync(blogPath, 'utf8');
  } catch (e) {
    console.error(e);
    res.status(500).send('Blog template missing.');
    return;
  }

  const postId = req.query && req.query.id != null ? String(req.query.id).trim() : '';

  let postData = null;
  if (postId && process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      ensureAdmin();
      const snap = await admin.firestore().collection('posts').doc(postId).get();
      if (snap.exists) postData = snap.data();
    } catch (e) {
      console.error('Firestore read failed:', e);
    }
  }

  const socialHead = buildSocialHead(origin, postId, postData);
  if (!template.includes(MARKER)) {
    res.status(500).send('Blog template misconfigured.');
    return;
  }

  const html = template.replace(MARKER, socialHead);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=600, stale-while-revalidate=86400');
  if (req.method === 'HEAD') {
    res.status(200).end();
    return;
  }
  res.status(200).send(html);
};
