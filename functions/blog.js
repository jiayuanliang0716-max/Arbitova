/**
 * Cloudflare Pages Function: /blog
 *
 * When ?post=slug is present, fetches the post from the API and injects
 * dynamic Open Graph / Twitter Card meta tags so social crawlers (X, LinkedIn,
 * Facebook, etc.) see the correct title, description, and preview image.
 *
 * Falls through to static blog.html for all other requests.
 */

const API = 'https://api.arbitova.com';
const SITE = 'https://arbitova.com';

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const slug = url.searchParams.get('post');

  // No post param — serve static blog.html as-is
  if (!slug) {
    return context.next();
  }

  // Fetch post data from API
  let post = null;
  try {
    const r = await fetch(`${API}/api/v1/posts/${slug}`);
    if (r.ok) post = await r.json();
  } catch (_) {}

  // If post not found, fall through to static page
  if (!post || post.error) {
    return context.next();
  }

  // Fetch base blog.html
  const staticRes = await context.next();
  const html = await staticRes.text();

  const title = post.title || 'Arbitova Blog';
  const description = post.excerpt || 'Updates, changelogs, and insights from the Arbitova team.';
  const image = post.cover_image || 'https://images.unsplash.com/photo-1451187580459-43490279c0fa?w=1200&h=675&fit=crop&q=80';
  const postUrl = `${SITE}/blog?post=${slug}`;

  // Build dynamic meta block
  const dynamicMeta = `
    <title>${escapeHtml(title)} — Arbitova</title>
    <link rel="canonical" href="${escapeHtml(postUrl)}">
    <meta name="description" content="${escapeHtml(description)}">
    <meta property="og:title" content="${escapeHtml(title)}">
    <meta property="og:description" content="${escapeHtml(description)}">
    <meta property="og:image" content="${escapeHtml(image)}">
    <meta property="og:url" content="${escapeHtml(postUrl)}">
    <meta property="og:type" content="article">
    <meta property="og:site_name" content="Arbitova">
    <meta name="twitter:card" content="summary_large_image">
    <meta name="twitter:title" content="${escapeHtml(title)}">
    <meta name="twitter:description" content="${escapeHtml(description)}">
    <meta name="twitter:image" content="${escapeHtml(image)}">`;

  // Replace the static <title> and inject dynamic meta right after <head>
  const patched = html
    .replace(/<title>[^<]*<\/title>/, '')
    .replace(/<meta name="description"[^>]*>/, '')
    .replace('<head>', `<head>${dynamicMeta}`);

  return new Response(patched, {
    headers: {
      'Content-Type': 'text/html;charset=UTF-8',
      'Cache-Control': 'public, max-age=60, s-maxage=60',
    },
  });
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
