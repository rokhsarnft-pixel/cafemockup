function slugify(text) {
  return String(text || "").toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

function urlBlock(loc, priority, changefreq) {
  return '<url>' +
    '<loc>' + loc + '</loc>' +
    '<xhtml:link rel="alternate" hreflang="en" href="' + loc + '"/>' +
    '<xhtml:link rel="alternate" hreflang="fa" href="' + loc + (loc.indexOf('?') === -1 ? '?lang=fa' : '&lang=fa') + '"/>' +
    '<xhtml:link rel="alternate" hreflang="x-default" href="' + loc + '"/>' +
    '<changefreq>' + changefreq + '</changefreq>' +
    '<priority>' + priority + '</priority>' +
    '</url>';
}

export async function onRequest(context) {
  var ADMIN_API = "https://cafemockup-admin.rokhsar-nft.workers.dev";
  var mockups = [];
  var tutorials = [];

  try {
    var mRes = await fetch(ADMIN_API + "/api/public/mockups");
    if (mRes.ok) mockups = await mRes.json();
  } catch (e) { mockups = []; }

  try {
    var tRes = await fetch(ADMIN_API + "/api/public/tutorials");
    if (tRes.ok) tutorials = await tRes.json();
  } catch (e) { tutorials = []; }

  var urls = [];
  urls.push(urlBlock("https://cafemockup.com/", "1.0", "weekly"));
  urls.push(urlBlock("https://cafemockup.com/tutorials", "0.8", "monthly"));
  urls.push(urlBlock("https://cafemockup.com/pricing", "0.6", "monthly"));
  urls.push(urlBlock("https://cafemockup.com/about", "0.5", "monthly"));

  if (Array.isArray(mockups)) {
    mockups.forEach(function (m) {
      var slug = slugify(m.name_en || "");
      var loc = "https://cafemockup.com/mockup/" + m.id + (slug ? ("-" + slug) : "");
      urls.push(urlBlock(loc, "0.7", "weekly"));
    });
  }

  if (Array.isArray(tutorials)) {
    tutorials.forEach(function (t) {
      var slug = slugify(t.title_en || "");
      var loc = "https://cafemockup.com/tutorial/" + t.id + (slug ? ("-" + slug) : "");
      urls.push(urlBlock(loc, "0.6", "monthly"));
    });
  }

  var xml = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">' +
    urls.join('') +
    '</urlset>';

  return new Response(xml, {
    status: 200,
    headers: { "Content-Type": "application/xml; charset=utf-8" }
  });
}
