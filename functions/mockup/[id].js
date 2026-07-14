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
  var mockupId = idMatch ? idMatch[1] : null;

  var indexUrl = new URL("/", request.url);
  var assetResponse = await context.env.ASSETS.fetch(new Request(indexUrl, request));

  if (!mockupId) {
    return assetResponse;
  }

  var ADMIN_API = "https://cafemockup-admin.rokhsar-nft.workers.dev";
  var mockup = null;
  try {
    var apiRes = await fetch(ADMIN_API + "/api/public/mockup/" + mockupId);
    if (apiRes.ok) {
      mockup = await apiRes.json();
    }
  } catch (e) {
    mockup = null;
  }

  if (!mockup) {
    return assetResponse;
  }

  var html = await assetResponse.text();

  var lang = url.searchParams.get("lang") === "fa" ? "fa" : "en";
  var name = (lang === "fa" ? mockup.name_fa : mockup.name_en) || mockup.name_en || "";
  var descRaw = (lang === "fa" ? mockup.description_fa : mockup.description_en) || "";
  var fallbackDesc = mockup.is_free
    ? ("Download the " + mockup.name_en + " PSD mockup for free. Instant download, commercial license included.")
    : ("Download the " + mockup.name_en + " PSD mockup. Secure crypto payment with Bitcoin, Ethereum and USDT.");
  var desc = descRaw || fallbackDesc;
  var pageTitle = name + " PSD Mockup | MockupCafe";
  var slug = slugify(mockup.name_en || "");
  var canonicalUrl = "https://cafemockup.com/mockup/" + mockupId + (slug ? ("-" + slug) : "");
  var imageUrl = mockup.image_url || "https://cafemockup.com/og-image.png";
  var priceValue = mockup.is_free ? "0" : String(mockup.price);

  var productSchema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "Product",
    "name": mockup.name_en,
    "image": imageUrl,
    "description": desc,
    "category": mockup.category,
    "offers": {
      "@type": "Offer",
      "url": canonicalUrl,
      "priceCurrency": "USD",
      "price": priceValue,
      "availability": "https://schema.org/InStock"
    }
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
  html = replaceOnce(html, /<\/head>/, '<script type="application/ld+json">' + productSchema + '</script></head>');

  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" }
  });
}
