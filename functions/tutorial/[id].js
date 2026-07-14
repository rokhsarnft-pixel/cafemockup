function slugify(text) {
  return String(text || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function replaceOnce(html, regex, replacement) {
  return html.replace(regex, function () { return replacement; });
}

export async function onRequest(context) {
  var request = context.request;
  var url = new URL(request.url);
  var idParam = (context.params && context.params.id) ? String(context.params.id) : "";
  var idMatch = idParam.match(/^(\d+)/);
  var tutorialId = idMatch ? idMatch[1] : null;

  var indexUrl = new URL("/", request.url);
  var assetResponse = await context.env.ASSETS.fetch(new Request(indexUrl, request));

  if (!tutorialId) {
    return assetResponse;
  }

  var ADMIN_API = "https://cafemockup-admin.rokhsar-nft.workers.dev";
  var tutorial = null;
  try {
    var apiRes = await fetch(ADMIN_API + "/api/public/tutorial/" + tutorialId);
    if (apiRes.ok) {
      tutorial = await apiRes.json();
    }
  } catch (e) {
    tutorial = null;
  }

  if (!tutorial) {
    return assetResponse;
  }

  var html = await assetResponse.text();

  var lang = url.searchParams.get("lang") === "fa" ? "fa" : "en";
  var title = (lang === "fa" ? tutorial.title_fa : tutorial.title_en) || tutorial.title_en || "";
  var desc = (lang === "fa" ? tutorial.intro_fa : tutorial.intro_en) || ("Learn about " + title + " with MockupCafe tutorials.");
  var pageTitle = title + " | MockupCafe Tutorials";
  var slug = slugify(tutorial.title_en || "");
  var canonicalUrl = "https://cafemockup.com/tutorial/" + tutorialId + (slug ? ("-" + slug) : "");
  var imageUrl = tutorial.image_url || "https://cafemockup.com/og-image.png";

  var articleSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": title,
    "image": imageUrl,
    "description": desc,
    "author": { "@type": "Organization", "name": "MockupCafe" }
  });

  html = replaceOnce(html, /<title>[\s\S]*?<\/title>/, "<title>" + escapeHtml(pageTitle) + "</title>");
  html = replaceOnce(html, /<meta name="description" content="[^"]*">/, '<meta name="description" content="' + escapeHtml(desc) + '">');
  html = replaceOnce(html, /<link rel="canonical" href="[^"]*">/, '<link rel="canonical" href="' + canonicalUrl + '">');
  html = replaceOnce(html, /<meta property="og:url" content="[^"]*">/, '<meta property="og:url" content="' + canonicalUrl + '">');
  html = replaceOnce(html, /<meta property="og:title" content="[^"]*">/, '<meta property="og:title" content="' + escapeHtml(pageTitle) + '">');
  html = replaceOnce(html, /<meta property="og:description" content="[^"]*">/, '<meta property="og:description" content="' + escapeHtml(desc) + '">');
  html = replaceOnce(html, /<meta property="og:image" content="[^"]*">/, '<meta property="og:image" content="' + imageUrl + '">');
  html = replaceOnce(html, /<meta name="twitter:title" content="[^"]*">/, '<meta name="twitter:title" content="' + escapeHtml(pageTitle) + '">');
  html = replaceOnce(html, /<meta name="twitter:description" content="[^"]*">/, '<meta name="twitter:description" content="' + escapeHtml(desc) + '">');
  html = replaceOnce(html, /<meta name="twitter:image" content="[^"]*">/, '<meta name="twitter:image" content="' + imageUrl + '">');
  html = replaceOnce(html, /<\/head>/, '<script type="application/ld+json">' + articleSchema + '</script></head>');

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}
