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

function shareDescription(body, title) {
  const t = String(body || '').replace(/\s+/g, ' ').trim();
  if (!t) return title || 'News Connect';
  return t.length > 220 ? `${t.slice(0, 217)}…` : t;
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
  const title = hasPost ? String(data.title) : 'News Connect';
  const desc = hasPost ? shareDescription(data.body, title) : 'Read the latest on News Connect.';
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
    <meta property="og:title" content="${escapeAttr(title)}">
    <meta property="og:description" content="${escapeAttr(desc)}">
    <meta property="og:image" content="${escapeAttr(image)}">
    <meta property="og:image:secure_url" content="${escapeAttr(image)}">
    <meta property="og:image:width" content="1200">
    <meta property="og:image:height" content="630">
    <meta property="og:image:alt" content="${escapeAttr(title)}">
    ${publishedMeta}
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:url" content="${escapeAttr(canonical)}">
    <meta name="twitter:title" content="${escapeAttr(title)}">
    <meta name="twitter:description" content="${escapeAttr(desc)}">
    <meta name="twitter:image" content="${escapeAttr(image)}">
    <meta name="twitter:image:alt" content="${escapeAttr(title)}">
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
