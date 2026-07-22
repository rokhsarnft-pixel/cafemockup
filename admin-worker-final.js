const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// Emails in this list get unlimited Upscaler access — no free-use limit, no subscription check.
var ADMIN_BYPASS_EMAILS = ["aidin.ghm@gmail.com"];

function json(data, status, extraHeaders) {
  if (status === undefined) status = 200;
  if (extraHeaders === undefined) extraHeaders = {};
  return new Response(JSON.stringify(data), {
    status: status,
    headers: Object.assign({ "Content-Type": "application/json; charset=utf-8" }, CORS_HEADERS, extraHeaders),
  });
}

function htmlResp(body) {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function checkAuth(request, env) {
  var cookie = request.headers.get("Cookie") || "";
  var match = cookie.match(/mc_admin_session=([^;]+)/);
  return match && match[1] === env.ADMIN_PASSWORD;
}

// Parses special order_id formats used for subscriptions and upscale credits.
// Formats: sub_monthly_{encodedEmail}_{timestamp}, sub_yearly_{encodedEmail}_{timestamp}, upscale_{encodedEmail}_{timestamp}
// Uses lastIndexOf("_") to split off the timestamp so emails containing underscores parse correctly.
// Converts an ArrayBuffer to a base64 string in fixed-size chunks (avoids call-stack limits on large images)
function bufferToBase64(buffer) {
  var bytes = new Uint8Array(buffer);
  var binary = "";
  var chunkSize = 8192;
  for (var i = 0; i < bytes.length; i += chunkSize) {
    var chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, chunk);
  }
  return btoa(binary);
}

// Converts a base64 string back to an ArrayBuffer
function base64ToArrayBuffer(base64) {
  var binaryString = atob(base64);
  var bytes = new Uint8Array(binaryString.length);
  for (var i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function parseSpecialOrderId(orderId) {
  var prefixes = [
    { key: "sub_monthly_", type: "sub_monthly" },
    { key: "sub_yearly_", type: "sub_yearly" },
    { key: "upscale_", type: "upscale" },
  ];
  for (var i = 0; i < prefixes.length; i++) {
    var p = prefixes[i];
    if (orderId.indexOf(p.key) === 0) {
      var rest = orderId.slice(p.key.length);
      var lastUnderscore = rest.lastIndexOf("_");
      if (lastUnderscore === -1) return null;
      var encodedEmail = rest.substring(0, lastUnderscore);
      var email = "";
      try {
        email = decodeURIComponent(encodedEmail);
      } catch (e) {
        email = encodedEmail;
      }
      return { type: p.type, email: email };
    }
  }
  return null;
}

export default {
  async fetch(request, env) {
    var url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // ── LOGIN ──
    if (url.pathname === "/api/login" && request.method === "POST") {
      var body = await request.json();
      if (body.password === env.ADMIN_PASSWORD) {
        return json({ ok: true }, 200, {
          "Set-Cookie": "mc_admin_session=" + env.ADMIN_PASSWORD + "; Path=/; HttpOnly; Max-Age=86400",
        });
      }
      return json({ ok: false, error: "Wrong password" }, 401);
    }

    // ── WEBHOOK from NowPayments (no auth needed) ──
    // NowPayments calls this when a payment status changes
    if (url.pathname === "/api/webhook" && request.method === "POST") {
      try {
        var wbody = await request.json();
        console.log("Webhook received:", JSON.stringify(wbody));

        var status = wbody.payment_status || "";
        var orderId = wbody.order_id || "";
        var paymentId = String(wbody.payment_id || "");
        var payCurrency = wbody.pay_currency || "";
        var actuallyPaid = wbody.actually_paid || wbody.pay_amount || 0;
        var priceAmount = wbody.price_amount || 0;

        // Only record confirmed/finished payments
        if (status === "finished" || status === "confirmed") {
          // Parse order_id to get email and mockup info
          // order_id format: mockupcafe_{timestamp} or mockupcafe_{timestamp}_{email}
          var customerEmail = "";
          var mockupName = "";

          // Try to extract from order description stored in DB if we have it
          // Also try to get mockup name from order_id metadata
          var orderParts = orderId.split("_");

          // Upsert order into DB
          await env.DB.prepare(
            "INSERT INTO orders (order_id, payment_id, customer_email, mockup_name, amount_usd, pay_currency, status, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now')) " +
            "ON CONFLICT(order_id) DO UPDATE SET " +
            "status = excluded.status, " +
            "payment_id = excluded.payment_id, " +
            "pay_currency = excluded.pay_currency, " +
            "amount_usd = excluded.amount_usd"
          ).bind(
            orderId,
            paymentId,
            customerEmail,
            mockupName,
            priceAmount,
            payCurrency,
            status
          ).run();

          console.log("Order saved:", orderId, status);

          // Handle subscription/upscale-credit order types, idempotently
          var special = parseSpecialOrderId(orderId);
          if (special) {
            var creditRow = await env.DB.prepare("SELECT credited FROM orders WHERE order_id = ?").bind(orderId).first();
            var alreadyCredited = creditRow && creditRow.credited === 1;
            if (!alreadyCredited) {
              if (special.type === "sub_monthly" || special.type === "sub_yearly") {
                var planKey = special.type === "sub_monthly" ? "monthly" : "yearly";
                var durationDays = special.type === "sub_monthly" ? 30 : 365;
                var existingSub = await env.DB.prepare("SELECT expires_at FROM subscriptions WHERE email = ?").bind(special.email).first();
                var baseDate = new Date();
                if (existingSub && new Date(existingSub.expires_at) > baseDate) {
                  baseDate = new Date(existingSub.expires_at);
                }
                var newExpiry = new Date(baseDate.getTime() + durationDays * 24 * 60 * 60 * 1000);
                await env.DB.prepare(
                  "INSERT INTO subscriptions (email, plan_key, expires_at, updated_at) VALUES (?, ?, ?, datetime('now')) " +
                  "ON CONFLICT(email) DO UPDATE SET plan_key = excluded.plan_key, expires_at = excluded.expires_at, updated_at = datetime('now')"
                ).bind(special.email, planKey, newExpiry.toISOString()).run();
              } else if (special.type === "upscale") {
                // Legacy path: direct upscale-credit purchases were replaced by subscription-based access.
                // Kept only so any old payment link still gets marked credited instead of erroring.
              }
              await env.DB.prepare("UPDATE orders SET credited = 1 WHERE order_id = ?").bind(orderId).run();
            }
          }
        } else {
          // For other statuses (waiting, confirming, etc.) - upsert with current status
          await env.DB.prepare(
            "INSERT INTO orders (order_id, payment_id, customer_email, mockup_name, amount_usd, pay_currency, status, created_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now')) " +
            "ON CONFLICT(order_id) DO UPDATE SET " +
            "status = excluded.status, " +
            "payment_id = excluded.payment_id"
          ).bind(
            orderId,
            paymentId,
            "",
            "",
            priceAmount,
            payCurrency,
            status
          ).run();
        }

        return json({ received: true, order_id: orderId, status: status });
      } catch (err) {
        console.error("Webhook error:", err.message);
        return json({ error: "Webhook error", details: err.message }, 500);
      }
    }

    // ── UPSCALER (no admin auth needed — used by regular site visitors) ──
    if (url.pathname === "/api/upscale" && request.method === "POST") {
      try {
        var formData = await request.formData();
        var upEmail = formData.get("email");
        var multiplier = parseInt(formData.get("multiplier"), 10) || 2;
        var file = formData.get("image");

        if (!upEmail) {
          return json({ error: "EMAIL_REQUIRED" }, 400);
        }
        if (!file) {
          return json({ error: "NO_FILE" }, 400);
        }
        if (file.size > 20 * 1024 * 1024) {
          return json({ error: "FILE_TOO_LARGE" }, 400);
        }
        var allowedTypes = ["image/jpeg", "image/png", "image/webp"];
        if (allowedTypes.indexOf(file.type) === -1) {
          return json({ error: "INVALID_FILE_TYPE" }, 400);
        }

        // Admin bypass: whitelisted emails skip free-use and subscription checks entirely
        var isAdminBypass = ADMIN_BYPASS_EMAILS.indexOf(String(upEmail).toLowerCase()) !== -1;

        // Monthly upscale credit limits per plan (edit here if pricing changes)
        var UPSCALE_MONTHLY_LIMITS = { monthly: 40, yearly: 50 };

        var isThisUseFree = false;

        if (!isAdminBypass) {
          var freeUseRow = await env.DB.prepare("SELECT COUNT(*) AS cnt FROM upscale_usage WHERE email = ? AND is_free_use = 1").bind(upEmail).first();
          var hasFreeUse = !freeUseRow || freeUseRow.cnt === 0;
          isThisUseFree = hasFreeUse;

          if (!hasFreeUse) {
            var subRow = await env.DB.prepare("SELECT plan_key, expires_at FROM subscriptions WHERE email = ?").bind(upEmail).first();
            var isSubscribed = subRow && new Date(subRow.expires_at) > new Date();
            if (!isSubscribed) {
              return json({ error: "PAYMENT_REQUIRED" }, 402);
            }
            var monthlyLimit = UPSCALE_MONTHLY_LIMITS[subRow.plan_key] || 0;
            var usedThisMonthRow = await env.DB.prepare(
              "SELECT COUNT(*) AS cnt FROM upscale_usage WHERE email = ? AND is_free_use = 0 AND strftime('%Y-%m', used_at) = strftime('%Y-%m','now')"
            ).bind(upEmail).first();
            var usedThisMonth = usedThisMonthRow ? usedThisMonthRow.cnt : 0;
            if (usedThisMonth >= monthlyLimit) {
              return json({ error: "MONTHLY_LIMIT_REACHED", limit: monthlyLimit, used: usedThisMonth }, 402);
            }
          }
        }

        var fileBuffer = await file.arrayBuffer();
        var infoStream = new Response(fileBuffer).body;
        var info = await env.IMAGES.info(infoStream);
        var origWidth = info.width;
        var origHeight = info.height;

        var targetWidth = origWidth * multiplier;
        var targetHeight = origHeight * multiplier;
        var maxPixels = 8000000;
        if (targetWidth * targetHeight > maxPixels) {
          var scaleDown = Math.sqrt(maxPixels / (targetWidth * targetHeight));
          targetWidth = Math.round(targetWidth * scaleDown);
          targetHeight = Math.round(targetHeight * scaleDown);
        }
        var targetMegapixels = Math.min(128, Math.max(1, Math.round((targetWidth * targetHeight) / 1000000)));

        var base64Image = bufferToBase64(fileBuffer);
        var dataUri = "data:" + file.type + ";base64," + base64Image;

        var aiResult = await env.AI.run("pruna/p-image-upscale", {
          image: dataUri,
          target: targetMegapixels,
          enhance_details: true,
          output_format: "jpg",
        });

        if (!aiResult || !aiResult.result || !aiResult.result.image) {
          throw new Error("Upscale model returned no image");
        }

        var resultDataUri = aiResult.result.image;
        var commaIdx = resultDataUri.indexOf(",");
        var semiIdx = resultDataUri.indexOf(";");
        var resultMime = resultDataUri.substring(5, semiIdx) || "image/jpeg";
        var resultBase64 = resultDataUri.substring(commaIdx + 1);
        var outputBuffer = base64ToArrayBuffer(resultBase64);

        await env.DB.prepare(
          "INSERT INTO upscale_usage (email, is_free_use, used_at) VALUES (?, ?, datetime('now'))"
        ).bind(upEmail, isAdminBypass ? 1 : (isThisUseFree ? 1 : 0)).run();

        var outHeaders = new Headers();
        outHeaders.set("Content-Type", resultMime);
        outHeaders.set("Access-Control-Allow-Origin", "*");
        return new Response(outputBuffer, { status: 200, headers: outHeaders });
      } catch (err) {
        console.error("Upscale error:", err.message);
        return json({ error: "UPSCALE_FAILED", details: err.message }, 500);
      }
    }

    if (url.pathname === "/api/public/subscription-status" && request.method === "GET") {
      var subEmail = url.searchParams.get("email");
      if (!subEmail) {
        return json({ error: "EMAIL_REQUIRED" }, 400);
      }
      var subStatusRow = await env.DB.prepare("SELECT plan_key, expires_at FROM subscriptions WHERE email = ?").bind(subEmail).first();
      var active = subStatusRow && new Date(subStatusRow.expires_at) > new Date();
      return json({
        active: !!active,
        plan_key: active ? subStatusRow.plan_key : null,
        expires_at: active ? subStatusRow.expires_at : null,
      });
    }

    // ── PUBLIC ROUTES ──
    var PUBLIC_ROUTES = ["/api/login", "/api/public/mockups", "/api/public/categories", "/api/public/tutorials", "/api/public/plans", "/api/webhook", "/api/upscale", "/api/public/subscription-status"];
    var isApiRoute = url.pathname.startsWith("/api/");
    var publicMockupItemMatch = url.pathname.match(/^\/api\/public\/mockup\/(\d+)$/);
    var publicTutorialItemMatch = url.pathname.match(/^\/api\/public\/tutorial\/(\d+)$/);
    var isPublicRoute = PUBLIC_ROUTES.indexOf(url.pathname) !== -1 || !!publicMockupItemMatch || !!publicTutorialItemMatch;

    if (isApiRoute && !isPublicRoute && !checkAuth(request, env)) {
      return json({ error: "Unauthorized" }, 401);
    }

    if (publicMockupItemMatch && request.method === "GET") {
      var rSingleMockup = await env.DB.prepare(
        "SELECT id, name_fa, name_en, category, is_free, price, image_url, download_url, icon, description_fa, description_en, gallery_images_json FROM mockups WHERE is_active = 1 AND id = ?"
      ).bind(publicMockupItemMatch[1]).first();
      if (!rSingleMockup) return json({ error: "Not found" }, 404);
      return json(rSingleMockup);
    }

    if (publicTutorialItemMatch && request.method === "GET") {
      var rSingleTutorial = await env.DB.prepare(
        "SELECT id, title_fa, title_en, intro_fa, intro_en, level, duration_fa, duration_en, type, icon, image_url, video_url, sections_json, tip_fa, tip_en, order_index FROM tutorials WHERE is_active = 1 AND id = ?"
      ).bind(publicTutorialItemMatch[1]).first();
      if (!rSingleTutorial) return json({ error: "Not found" }, 404);
      return json(rSingleTutorial);
    }

    if (url.pathname === "/api/public/mockups" && request.method === "GET") {
      var r1 = await env.DB.prepare(
        "SELECT id, name_fa, name_en, category, is_free, price, image_url, download_url, icon, description_fa, description_en, gallery_images_json FROM mockups WHERE is_active = 1 ORDER BY id ASC"
      ).all();
      return json(r1.results);
    }

    if (url.pathname === "/api/public/categories" && request.method === "GET") {
      var r2 = await env.DB.prepare("SELECT id, name_en, name_fa FROM categories ORDER BY name_en ASC").all();
      return json(r2.results);
    }

    if (url.pathname === "/api/categories" && request.method === "GET") {
      var r3 = await env.DB.prepare("SELECT * FROM categories ORDER BY name_en ASC").all();
      return json(r3.results);
    }

    if (url.pathname === "/api/categories" && request.method === "POST") {
      var catBody = await request.json();
      var r4 = await env.DB.prepare("INSERT INTO categories (name_en, name_fa) VALUES (?, ?)").bind(catBody.name_en, catBody.name_fa).run();
      return json({ ok: true, id: r4.meta.last_row_id });
    }

    var catIdMatch = url.pathname.match(/^\/api\/categories\/(\d+)$/);
    if (catIdMatch && request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM categories WHERE id=?").bind(catIdMatch[1]).run();
      return json({ ok: true });
    }

    if (url.pathname === "/api/mockups" && request.method === "GET") {
      var r5 = await env.DB.prepare("SELECT * FROM mockups ORDER BY id DESC").all();
      return json(r5.results);
    }

    if (url.pathname === "/api/mockups" && request.method === "POST") {
      var m1 = await request.json();
      var r6 = await env.DB.prepare(
        "INSERT INTO mockups (name_fa, name_en, category, is_free, price, image_url, download_url, icon, description_fa, description_en, gallery_images_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(m1.name_fa, m1.name_en, m1.category, m1.is_free ? 1 : 0, m1.price || 0, m1.image_url || "", m1.download_url || "", m1.icon || "ti-box", m1.description_fa || "", m1.description_en || "", m1.gallery_images_json || "[]").run();
      return json({ ok: true, id: r6.meta.last_row_id });
    }

    if (url.pathname === "/api/mockups/bulk-import" && request.method === "POST") {
      var bulkBody = await request.json();
      var rows = bulkBody.rows || [];
      if (!Array.isArray(rows) || rows.length === 0) {
        return json({ error: "No rows provided" }, 400);
      }
      if (rows.length > 500) {
        return json({ error: "Too many rows in one import (max 500)." }, 400);
      }

      var rowErrors = [];
      for (var ri = 0; ri < rows.length; ri++) {
        var rr = rows[ri];
        var rowNum = ri + 2; // +2 because row 1 is the CSV header, and rows are 0-indexed here
        if (!rr.name_en || !String(rr.name_en).trim()) {
          rowErrors.push("Row " + rowNum + ": name_en is required");
          continue;
        }
        var rrIsFree = rr.is_free === true || rr.is_free === "true" || rr.is_free === "1" || rr.is_free === 1;
        var rrPrice = parseFloat(rr.price) || 0;
        if (!rrIsFree && rrPrice < 20) {
          rowErrors.push("Row " + rowNum + " (" + rr.name_en + "): paid mockups must be $20 or more");
        }
      }

      if (rowErrors.length > 0) {
        return json({ error: "Validation failed", details: rowErrors }, 400);
      }

      var stmts = [];
      for (var rj = 0; rj < rows.length; rj++) {
        var row = rows[rj];
        var rowIsFree = row.is_free === true || row.is_free === "true" || row.is_free === "1" || row.is_free === 1;
        var rowPrice = rowIsFree ? 0 : (parseFloat(row.price) || 0);
        var rowGallery = "[]";
        if (row.gallery_images) {
          var galleryUrls = String(row.gallery_images).split("|").map(function (u) { return u.trim(); }).filter(function (u) { return !!u; });
          rowGallery = JSON.stringify(galleryUrls);
        } else if (row.gallery_images_json) {
          rowGallery = row.gallery_images_json;
        }
        stmts.push(
          env.DB.prepare(
            "INSERT INTO mockups (name_fa, name_en, category, is_free, price, image_url, download_url, icon, description_fa, description_en, gallery_images_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          ).bind(
            row.name_fa || "",
            row.name_en,
            row.category || "",
            rowIsFree ? 1 : 0,
            rowPrice,
            row.image_url || "",
            row.download_url || "",
            row.icon || "ti-box",
            row.description_fa || "",
            row.description_en || "",
            rowGallery
          )
        );
      }

      var batchResults = await env.DB.batch(stmts);
      return json({ ok: true, imported: batchResults.length });
    }

    var mockupIdMatch = url.pathname.match(/^\/api\/mockups\/(\d+)$/);
    if (mockupIdMatch && request.method === "PUT") {
      var mid = mockupIdMatch[1];
      var m2 = await request.json();
      await env.DB.prepare(
        "UPDATE mockups SET name_fa=?, name_en=?, category=?, is_free=?, price=?, image_url=?, download_url=?, icon=?, is_active=?, description_fa=?, description_en=?, gallery_images_json=?, updated_at=datetime('now') WHERE id=?"
      ).bind(m2.name_fa, m2.name_en, m2.category, m2.is_free ? 1 : 0, m2.price || 0, m2.image_url || "", m2.download_url || "", m2.icon || "ti-box", m2.is_active ? 1 : 0, m2.description_fa || "", m2.description_en || "", m2.gallery_images_json || "[]", mid).run();
      return json({ ok: true });
    }

    if (mockupIdMatch && request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM mockups WHERE id=?").bind(mockupIdMatch[1]).run();
      return json({ ok: true });
    }

    if (url.pathname === "/api/public/tutorials" && request.method === "GET") {
      var rt1 = await env.DB.prepare(
        "SELECT id, title_fa, title_en, intro_fa, intro_en, level, duration_fa, duration_en, type, icon, image_url, video_url, sections_json, tip_fa, tip_en, order_index FROM tutorials WHERE is_active = 1 ORDER BY order_index ASC, id ASC"
      ).all();
      return json(rt1.results);
    }

    if (url.pathname === "/api/tutorials" && request.method === "GET") {
      var rt2 = await env.DB.prepare("SELECT * FROM tutorials ORDER BY order_index ASC, id ASC").all();
      return json(rt2.results);
    }

    if (url.pathname === "/api/tutorials" && request.method === "POST") {
      var t1 = await request.json();
      var rt3 = await env.DB.prepare(
        "INSERT INTO tutorials (title_fa, title_en, intro_fa, intro_en, level, duration_fa, duration_en, type, icon, image_url, video_url, sections_json, tip_fa, tip_en, order_index, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        t1.title_fa || "", t1.title_en, t1.intro_fa || "", t1.intro_en || "", t1.level || "beginner",
        t1.duration_fa || "", t1.duration_en || "", t1.type || "video", t1.icon || "ti-books",
        t1.image_url || "", t1.video_url || "", t1.sections_json || "[]", t1.tip_fa || "", t1.tip_en || "",
        t1.order_index || 0, t1.is_active === false ? 0 : 1
      ).run();
      return json({ ok: true, id: rt3.meta.last_row_id });
    }

    var tutorialIdMatch = url.pathname.match(/^\/api\/tutorials\/(\d+)$/);
    if (tutorialIdMatch && request.method === "PUT") {
      var tid = tutorialIdMatch[1];
      var t2 = await request.json();
      await env.DB.prepare(
        "UPDATE tutorials SET title_fa=?, title_en=?, intro_fa=?, intro_en=?, level=?, duration_fa=?, duration_en=?, type=?, icon=?, image_url=?, video_url=?, sections_json=?, tip_fa=?, tip_en=?, order_index=?, is_active=?, updated_at=datetime('now') WHERE id=?"
      ).bind(
        t2.title_fa || "", t2.title_en, t2.intro_fa || "", t2.intro_en || "", t2.level || "beginner",
        t2.duration_fa || "", t2.duration_en || "", t2.type || "video", t2.icon || "ti-books",
        t2.image_url || "", t2.video_url || "", t2.sections_json || "[]", t2.tip_fa || "", t2.tip_en || "",
        t2.order_index || 0, t2.is_active ? 1 : 0, tid
      ).run();
      return json({ ok: true });
    }

    if (tutorialIdMatch && request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM tutorials WHERE id=?").bind(tutorialIdMatch[1]).run();
      return json({ ok: true });
    }

    if (url.pathname === "/api/public/plans" && request.method === "GET") {
      var rp1 = await env.DB.prepare(
        "SELECT id, tag_fa, tag_en, tag_icon, name, price, period_fa, period_en, features_json, button_label_fa, button_label_en, is_best, is_disabled, order_index FROM plans WHERE is_active = 1 ORDER BY order_index ASC, id ASC"
      ).all();
      return json(rp1.results);
    }

    if (url.pathname === "/api/plans" && request.method === "GET") {
      var rp2 = await env.DB.prepare("SELECT * FROM plans ORDER BY order_index ASC, id ASC").all();
      return json(rp2.results);
    }

    if (url.pathname === "/api/plans" && request.method === "POST") {
      var p1 = await request.json();
      var rp3 = await env.DB.prepare(
        "INSERT INTO plans (tag_fa, tag_en, tag_icon, name, price, period_fa, period_en, features_json, button_label_fa, button_label_en, is_best, is_disabled, order_index, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).bind(
        p1.tag_fa || "", p1.tag_en || "", p1.tag_icon || "ti-coffee", p1.name, p1.price || 0,
        p1.period_fa || "/ماه", p1.period_en || "/mo", p1.features_json || "[]",
        p1.button_label_fa || "به‌زودی", p1.button_label_en || "Coming Soon",
        p1.is_best ? 1 : 0, p1.is_disabled === false ? 0 : 1, p1.order_index || 0, p1.is_active === false ? 0 : 1
      ).run();
      return json({ ok: true, id: rp3.meta.last_row_id });
    }

    var planIdMatch = url.pathname.match(/^\/api\/plans\/(\d+)$/);
    if (planIdMatch && request.method === "PUT") {
      var pid = planIdMatch[1];
      var p2 = await request.json();
      await env.DB.prepare(
        "UPDATE plans SET tag_fa=?, tag_en=?, tag_icon=?, name=?, price=?, period_fa=?, period_en=?, features_json=?, button_label_fa=?, button_label_en=?, is_best=?, is_disabled=?, order_index=?, is_active=?, updated_at=datetime('now') WHERE id=?"
      ).bind(
        p2.tag_fa || "", p2.tag_en || "", p2.tag_icon || "ti-coffee", p2.name, p2.price || 0,
        p2.period_fa || "/ماه", p2.period_en || "/mo", p2.features_json || "[]",
        p2.button_label_fa || "به‌زودی", p2.button_label_en || "Coming Soon",
        p2.is_best ? 1 : 0, p2.is_disabled ? 1 : 0, p2.order_index || 0, p2.is_active ? 1 : 0, pid
      ).run();
      return json({ ok: true });
    }

    if (planIdMatch && request.method === "DELETE") {
      await env.DB.prepare("DELETE FROM plans WHERE id=?").bind(planIdMatch[1]).run();
      return json({ ok: true });
    }

    if (url.pathname === "/api/orders" && request.method === "GET") {
      var r7 = await env.DB.prepare("SELECT * FROM orders ORDER BY id DESC LIMIT 200").all();
      return json(r7.results);
    }

    // Manual order update (e.g. add email/mockup name after the fact)
    if (url.pathname === "/api/orders" && request.method === "POST") {
      var oBody = await request.json();
      await env.DB.prepare(
        "INSERT INTO orders (order_id, payment_id, customer_email, mockup_name, amount_usd, pay_currency, status, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now')) " +
        "ON CONFLICT(order_id) DO UPDATE SET " +
        "customer_email = excluded.customer_email, " +
        "mockup_name = excluded.mockup_name, " +
        "status = excluded.status"
      ).bind(
        oBody.order_id, oBody.payment_id || "", oBody.customer_email || "",
        oBody.mockup_name || "", oBody.amount_usd || 0, oBody.pay_currency || "", oBody.status || "finished"
      ).run();
      return json({ ok: true });
    }

    if (url.pathname === "/api/settings" && request.method === "GET") {
      var r8 = await env.DB.prepare("SELECT * FROM settings").all();
      return json(r8.results);
    }

    if (url.pathname === "/api/settings" && request.method === "POST") {
      var sBody = await request.json();
      await env.DB.prepare(
        "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=datetime('now')"
      ).bind(sBody.key, sBody.value).run();
      return json({ ok: true });
    }

    if (url.pathname === "/" || url.pathname === "") {
      return htmlResp(getDashboardHtml());
    }

    return json({ error: "Not found" }, 404);
  },
};

function getDashboardHtml() {
  return '<!DOCTYPE html>' +
'<html lang="en">' +
'<head>' +
'<meta charset="UTF-8">' +
'<meta name="viewport" content="width=device-width,initial-scale=1">' +
'<title>MockupCafe Admin</title>' +
'<style>' +
'*{box-sizing:border-box;margin:0;padding:0;}' +
'body{font-family:"Segoe UI",Arial,sans-serif;background:#071E36;color:#fff;min-height:100vh;}' +
'.wrap{max-width:1200px;margin:0 auto;padding:2rem 1.5rem;}' +
'h1{font-size:1.4rem;margin-bottom:1.5rem;display:flex;align-items:center;gap:10px;}' +
'h1 span{color:#C07840;}' +
'#loginScreen{display:flex;align-items:center;justify-content:center;min-height:100vh;}' +
'.login-box{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:2.5rem;max-width:340px;width:100%;text-align:center;}' +
'.login-box h2{margin-bottom:1.5rem;font-size:1.2rem;}' +
'.login-box input{width:100%;padding:12px;border-radius:8px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:#fff;margin-bottom:1rem;font-size:.95rem;}' +
'.login-box button{width:100%;padding:12px;border-radius:8px;border:none;background:#C07840;color:#fff;font-weight:700;cursor:pointer;font-size:.95rem;}' +
'.login-error{color:#f5a8a0;font-size:.82rem;margin-bottom:1rem;display:none;}' +
'.tabs{display:flex;gap:6px;margin-bottom:1.5rem;border-bottom:1px solid rgba(255,255,255,.1);padding-bottom:0;}' +
'.tab{padding:10px 18px;background:none;border:none;color:rgba(255,255,255,.6);cursor:pointer;font-size:.9rem;border-bottom:2px solid transparent;margin-bottom:-1px;}' +
'.tab.active{color:#fff;border-bottom-color:#C07840;}' +
'.panel{display:none;}.panel.active{display:block;}' +
'table{width:100%;border-collapse:collapse;background:rgba(255,255,255,.04);border-radius:10px;overflow:hidden;}' +
'th,td{padding:10px 12px;text-align:left;font-size:.83rem;border-bottom:1px solid rgba(255,255,255,.07);}' +
'th{background:rgba(255,255,255,.06);font-weight:700;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;}' +
'tr:hover td{background:rgba(255,255,255,.03);}' +
'.thumb-img{width:56px;height:42px;object-fit:cover;border-radius:6px;border:1px solid rgba(255,255,255,.1);}' +
'.thumb-empty{width:56px;height:42px;border-radius:6px;border:1px dashed rgba(255,255,255,.15);display:flex;align-items:center;justify-content:center;font-size:1.2rem;color:rgba(255,255,255,.2);}' +
'.badge{padding:3px 10px;border-radius:6px;font-size:.72rem;font-weight:700;}' +
'.badge.free{background:rgba(93,202,165,.18);color:#5DCAA5;}' +
'.badge.paid{background:rgba(192,120,64,.18);color:#C07840;}' +
'.badge.yes{background:rgba(93,202,165,.12);color:#5DCAA5;}' +
'.badge.no{background:rgba(255,255,255,.08);color:rgba(255,255,255,.4);}' +
'.badge.status-finished,.badge.status-confirmed{background:rgba(93,202,165,.18);color:#5DCAA5;}' +
'.badge.status-waiting,.badge.status-confirming{background:rgba(239,159,39,.18);color:#EF9F27;}' +
'.badge.status-failed,.badge.status-expired{background:rgba(226,75,74,.18);color:#E24B4A;}' +
'.btn{padding:6px 12px;border-radius:6px;border:none;cursor:pointer;font-size:.78rem;font-weight:600;}' +
'.btn-primary{background:#C07840;color:#fff;}' +
'.btn-danger{background:rgba(226,75,74,.18);color:#E24B4A;border:1px solid rgba(226,75,74,.25);}' +
'.btn-edit{background:rgba(91,170,220,.18);color:#5BAADC;border:1px solid rgba(91,170,220,.25);margin-right:4px;}' +
'.btn-sm{padding:4px 9px;font-size:.72rem;}' +
'.toolbar{display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;}' +
'.cat-section{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:10px;padding:1rem 1.25rem;margin-bottom:1.25rem;}' +
'.cat-section h4{font-size:.85rem;font-weight:700;margin-bottom:.75rem;color:rgba(255,255,255,.7);}' +
'.cat-list{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:.75rem;min-height:32px;}' +
'.cat-chip{display:flex;align-items:center;gap:5px;background:rgba(255,255,255,.08);border-radius:20px;padding:4px 12px;font-size:.78rem;}' +
'.cat-chip button{background:none;border:none;color:rgba(255,255,255,.4);cursor:pointer;font-size:1rem;line-height:1;padding:0 0 0 4px;}' +
'.cat-add-row{display:flex;gap:8px;}' +
'.cat-add-row input{flex:1;padding:7px 10px;border-radius:7px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.06);color:#fff;font-size:.82rem;}' +
'.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.65);display:none;align-items:center;justify-content:center;z-index:100;padding:1rem;}' +
'.modal-overlay.open{display:flex;}' +
'.modal{background:#0A2744;border:1px solid rgba(255,255,255,.15);border-radius:14px;padding:1.75rem;max-width:520px;width:100%;max-height:92vh;overflow-y:auto;}' +
'.modal h3{margin-bottom:1.25rem;font-size:1.05rem;}' +
'.form-row{margin-bottom:.85rem;}' +
'.form-row label{display:block;font-size:.75rem;color:rgba(255,255,255,.55);margin-bottom:4px;font-weight:600;}' +
'.form-row input,.form-row select,.form-row textarea{width:100%;padding:9px 10px;border-radius:7px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.06);color:#fff;font-size:.85rem;font-family:inherit;}' +
'.form-row textarea{resize:vertical;min-height:70px;}' +
'.form-row select option{background:#0A2744;}' +
'.form-row-inline{display:flex;align-items:center;gap:8px;padding:4px 0;}' +
'.form-row-inline label{margin:0;font-size:.85rem;color:rgba(255,255,255,.75);}' +
'.sec-title{font-size:.72rem;font-weight:700;text-transform:uppercase;letter-spacing:.06em;color:#C07840;margin:1.1rem 0 .6rem;padding-bottom:.4rem;border-bottom:1px solid rgba(192,120,64,.2);}' +
'.img-preview{width:100%;height:120px;object-fit:contain;border-radius:8px;border:1px solid rgba(255,255,255,.1);background:rgba(255,255,255,.04);margin-top:6px;display:none;}' +
'.modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:1.25rem;padding-top:1rem;border-top:1px solid rgba(255,255,255,.08);}' +
'.settings-row{display:flex;justify-content:space-between;align-items:center;background:rgba(255,255,255,.04);padding:14px 16px;border-radius:10px;margin-bottom:8px;}' +
'.settings-row input{width:200px;padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.08);color:#fff;}' +
'.empty-row td{text-align:center;color:rgba(255,255,255,.3);padding:2rem!important;}' +
'</style>' +
'</head>' +
'<body>' +
'<div id="loginScreen">' +
'<div class="login-box">' +
'<h2>&#9749; MockupCafe Admin</h2>' +
'<div class="login-error" id="loginError">Wrong password.</div>' +
'<input type="password" id="loginPassword" placeholder="Admin password" onkeydown="if(event.key===\'Enter\')doLogin()">' +
'<button onclick="doLogin()">Login</button>' +
'</div>' +
'</div>' +
'<div id="dashboard" class="wrap" style="display:none;">' +
'<h1>&#9749; MockupCafe <span>Admin</span></h1>' +
'<div class="tabs">' +
'<button class="tab active" onclick="showTab(\'mockups\',this)">Mockups</button>' +
'<button class="tab" onclick="showTab(\'categories\',this)">Categories</button>' +
'<button class="tab" onclick="showTab(\'tutorials\',this)">Tutorials</button>' +
'<button class="tab" onclick="showTab(\'plans\',this)">Plans</button>' +
'<button class="tab" onclick="showTab(\'orders\',this)">Orders</button>' +
'<button class="tab" onclick="showTab(\'settings\',this)">Settings</button>' +
'</div>' +
'<div class="panel active" id="panel-mockups">' +
'<div class="toolbar"><span id="mockupCount" style="font-size:.85rem;color:rgba(255,255,255,.4)"></span><div><button class="btn" style="margin-left:8px;" onclick="openBulkImportForm()">Bulk Import CSV</button><button class="btn btn-primary" onclick="openMockupForm()">+ Add Mockup</button></div></div>' +
'<table><thead><tr><th>Preview</th><th>Name</th><th>Category</th><th>Price</th><th>Active</th><th>Actions</th></tr></thead><tbody id="mockupsTableBody"></tbody></table>' +
'</div>' +
'<div class="panel" id="panel-categories">' +
'<div class="cat-section">' +
'<h4>Manage Categories</h4>' +
'<div class="cat-list" id="catList"></div>' +
'<div class="cat-add-row">' +
'<input id="newCatEn" placeholder="English name (e.g. Packaging)">' +
'<input id="newCatFa" placeholder="نام فارسی">' +
'<button class="btn btn-primary" onclick="addCategory()">+ Add</button>' +
'</div></div>' +
'</div>' +
'<div class="panel" id="panel-tutorials">' +
'<div class="toolbar"><span id="tutorialCount" style="font-size:.85rem;color:rgba(255,255,255,.4)"></span><button class="btn btn-primary" onclick="openTutorialForm()">+ Add Tutorial</button></div>' +
'<table><thead><tr><th>Cover</th><th>Title</th><th>Level</th><th>Type</th><th>Order</th><th>Active</th><th>Actions</th></tr></thead><tbody id="tutorialsTableBody"></tbody></table>' +
'</div>' +
'<div class="panel" id="panel-plans">' +
'<div class="toolbar"><span id="planCount" style="font-size:.85rem;color:rgba(255,255,255,.4)"></span><button class="btn btn-primary" onclick="openPlanForm()">+ Add Plan</button></div>' +
'<table><thead><tr><th>Tag</th><th>Name</th><th>Price</th><th>Best</th><th>Enabled</th><th>Order</th><th>Active</th><th>Actions</th></tr></thead><tbody id="plansTableBody"></tbody></table>' +
'</div>' +
'<div class="panel" id="panel-orders">' +
'<table><thead><tr><th>Order ID</th><th>Email</th><th>Mockup</th><th>Amount</th><th>Currency</th><th>Status</th><th>Date</th></tr></thead><tbody id="ordersTableBody"></tbody></table>' +
'</div>' +
'<div class="panel" id="panel-settings"><div id="settingsList"></div></div>' +
'</div>' +
'<div class="modal-overlay" id="mockupModalOverlay">' +
'<div class="modal">' +
'<h3 id="mockupModalTitle">Add Mockup</h3>' +
'<input type="hidden" id="mockupId">' +
'<div class="sec-title">Basic Info</div>' +
'<div class="form-row"><label>Name (English) *</label><input id="mFieldEn" placeholder="e.g. Cold Brew Bottle"></div>' +
'<div class="form-row"><label>Name (Persian)</label><input id="mFieldFa" placeholder="مثلاً بطری کلد برو"></div>' +
'<div class="form-row"><label>Category</label><select id="mFieldCat"></select></div>' +
'<div class="sec-title">Description</div>' +
'<div class="form-row"><label>Description (English)</label><textarea id="mFieldDescEn" placeholder="Describe this mockup..."></textarea></div>' +
'<div class="form-row"><label>Description (Persian)</label><textarea id="mFieldDescFa" placeholder="توضیحات فارسی..."></textarea></div>' +
'<div class="sec-title">Pricing</div>' +
'<div class="form-row form-row-inline"><input type="checkbox" id="mFieldFree" onchange="togglePriceField()"><label>Free mockup</label></div>' +
'<div class="form-row" id="priceRow"><label>Price USD (min $20 for paid)</label><input type="number" id="mFieldPrice" value="25" min="0"></div>' +
'<div class="sec-title">Files</div>' +
'<div class="form-row"><label>Preview Image URL (JPG from GitHub) — main/cover image</label><input id="mFieldImage" placeholder="https://github.com/.../preview.jpg" oninput="previewImg(this.value)"><img id="imgPreview" class="img-preview" alt="preview"></div>' +
'<div class="form-row"><label>Extra Gallery Images (JSON array of URLs, shown as thumbnails on detail page)</label><textarea id="mFieldGalleryImages" style="min-height:70px;font-family:monospace;font-size:.78rem;" placeholder=\'["https://.../angle2.jpg","https://.../angle3.jpg"]\'></textarea></div>' +
'<div class="form-row"><label>Download File URL (ZIP/RAR from GitHub)</label><input id="mFieldDownload" placeholder="https://github.com/.../file.zip"></div>' +
'<div class="form-row form-row-inline"><input type="checkbox" id="mFieldActive" checked><label>Visible on site</label></div>' +
'<div class="modal-actions"><button class="btn" onclick="closeMockupForm()">Cancel</button><button class="btn btn-primary" onclick="saveMockup()">Save Mockup</button></div>' +
'</div></div>' +
'<div class="modal-overlay" id="bulkImportModalOverlay">' +
'<div class="modal">' +
'<h3>Bulk Import Mockups (CSV)</h3>' +
'<div class="sec-title">CSV Format</div>' +
'<div class="form-row"><label style="font-weight:400;color:rgba(255,255,255,.6);">First row must be a header with these exact column names (order doesn\'t matter, extra columns are ignored):<br><code style="font-size:.72rem;">name_en,name_fa,category,is_free,price,image_url,download_url,description_en,description_fa,gallery_images</code><br><br>- <code>is_free</code>: true/false or 1/0<br>- <code>price</code>: number, ignored if is_free is true, must be 20 or more if paid<br>- <code>gallery_images</code>: optional, multiple URLs separated by a pipe character | (e.g. url1|url2)</label></div>' +
'<div class="sec-title">Paste CSV Content</div>' +
'<div class="form-row"><textarea id="bulkCsvInput" style="min-height:220px;font-family:monospace;font-size:.78rem;" placeholder="name_en,name_fa,category,is_free,price,image_url,download_url,description_en,description_fa,gallery_images"></textarea></div>' +
'<div id="bulkImportPreview" style="font-size:.82rem;color:rgba(255,255,255,.6);margin-bottom:.5rem;"></div>' +
'<div id="bulkImportErrors" style="font-size:.78rem;color:#E24B4A;margin-bottom:.5rem;white-space:pre-wrap;"></div>' +
'<div class="modal-actions"><button class="btn" onclick="closeBulkImportForm()">Cancel</button><button class="btn btn-primary" onclick="submitBulkImport()">Import</button></div>' +
'</div></div>' +
'<div class="modal-overlay" id="tutorialModalOverlay">' +
'<div class="modal">' +
'<h3 id="tutorialModalTitle">Add Tutorial</h3>' +
'<input type="hidden" id="tutorialId">' +
'<div class="sec-title">Basic Info</div>' +
'<div class="form-row"><label>Title (English) *</label><input id="tFieldTitleEn" placeholder="e.g. What is a Mockup?"></div>' +
'<div class="form-row"><label>Title (Persian)</label><input id="tFieldTitleFa" placeholder="مثلاً موکاپ چیست؟"></div>' +
'<div class="form-row"><label>Intro (English)</label><textarea id="tFieldIntroEn" placeholder="Short intro paragraph..."></textarea></div>' +
'<div class="form-row"><label>Intro (Persian)</label><textarea id="tFieldIntroFa" placeholder="مقدمه کوتاه..."></textarea></div>' +
'<div class="sec-title">Classification</div>' +
'<div class="form-row"><label>Level</label><select id="tFieldLevel"><option value="beginner">Beginner</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option></select></div>' +
'<div class="form-row"><label>Type</label><select id="tFieldType"><option value="video">Video</option><option value="article">Article</option></select></div>' +
'<div class="form-row"><label>Duration (English, e.g. "15 min")</label><input id="tFieldDurationEn" placeholder="15 min"></div>' +
'<div class="form-row"><label>Duration (Persian, e.g. "۱۵ دقیقه")</label><input id="tFieldDurationFa" placeholder="۱۵ دقیقه"></div>' +
'<div class="form-row"><label>Icon (Tabler icon class)</label><input id="tFieldIcon" placeholder="ti-books"></div>' +
'<div class="sec-title">Media</div>' +
'<div class="form-row"><label>Cover Image URL (JPG/PNG from GitHub)</label><input id="tFieldImage" placeholder="https://github.com/.../cover.jpg" oninput="previewTutorialImg(this.value)"><img id="tutorialImgPreview" class="img-preview" alt="preview"></div>' +
'<div class="form-row"><label>YouTube Video URL (optional, for video-type tutorials)</label><input id="tFieldVideoUrl" placeholder="https://www.youtube.com/watch?v=..."></div>' +
'<div class="sec-title">Content</div>' +
'<div class="form-row"><label>Sections (JSON array — icon, title_en, title_fa, body_en, body_fa, list_en, list_fa)</label><textarea id="tFieldSections" style="min-height:140px;font-family:monospace;font-size:.78rem;" placeholder=\'[{"icon":"ti-bulb","title_en":"Why it matters","title_fa":"چرا مهم است","body_en":"...","body_fa":"..."}]\'></textarea></div>' +
'<div class="form-row"><label>Tip (English)</label><textarea id="tFieldTipEn" placeholder="Closing tip..."></textarea></div>' +
'<div class="form-row"><label>Tip (Persian)</label><textarea id="tFieldTipFa" placeholder="نکته پایانی..."></textarea></div>' +
'<div class="sec-title">Display</div>' +
'<div class="form-row"><label>Order (lower shows first)</label><input type="number" id="tFieldOrder" value="0"></div>' +
'<div class="form-row form-row-inline"><input type="checkbox" id="tFieldActive" checked><label>Visible on site</label></div>' +
'<div class="modal-actions"><button class="btn" onclick="closeTutorialForm()">Cancel</button><button class="btn btn-primary" onclick="saveTutorial()">Save Tutorial</button></div>' +
'</div></div>' +
'<div class="modal-overlay" id="planModalOverlay">' +
'<div class="modal">' +
'<h3 id="planModalTitle">Add Plan</h3>' +
'<input type="hidden" id="planId">' +
'<div class="sec-title">Basic Info</div>' +
'<div class="form-row"><label>Plan Name *</label><input id="pFieldName" placeholder="e.g. Pro Espresso"></div>' +
'<div class="form-row"><label>Tag (English)</label><input id="pFieldTagEn" placeholder="e.g. Best Seller"></div>' +
'<div class="form-row"><label>Tag (Persian)</label><input id="pFieldTagFa" placeholder="مثلاً پرفروش‌ترین"></div>' +
'<div class="form-row"><label>Tag Icon (Tabler icon class)</label><input id="pFieldTagIcon" placeholder="ti-star"></div>' +
'<div class="sec-title">Pricing</div>' +
'<div class="form-row"><label>Price USD (per period)</label><input type="number" id="pFieldPrice" value="0" min="0"></div>' +
'<div class="form-row"><label>Period label (English, e.g. "/mo")</label><input id="pFieldPeriodEn" placeholder="/mo"></div>' +
'<div class="form-row"><label>Period label (Persian, e.g. "/ماه")</label><input id="pFieldPeriodFa" placeholder="/ماه"></div>' +
'<div class="sec-title">Features</div>' +
'<div class="form-row"><label>Features (JSON array of {"fa":"...","en":"..."})</label><textarea id="pFieldFeatures" style="min-height:120px;font-family:monospace;font-size:.78rem;" placeholder=\'[{"fa":"۲۰ موکاپ رایگان","en":"20 free mockups"}]\'></textarea></div>' +
'<div class="sec-title">Button</div>' +
'<div class="form-row"><label>Button Label (English)</label><input id="pFieldBtnEn" placeholder="Coming Soon"></div>' +
'<div class="form-row"><label>Button Label (Persian)</label><input id="pFieldBtnFa" placeholder="به‌زودی"></div>' +
'<div class="form-row form-row-inline"><input type="checkbox" id="pFieldDisabled" checked><label>Button disabled (plan not purchasable yet)</label></div>' +
'<div class="sec-title">Display</div>' +
'<div class="form-row form-row-inline"><input type="checkbox" id="pFieldBest"><label>Highlight as Best Seller</label></div>' +
'<div class="form-row"><label>Order (lower shows first)</label><input type="number" id="pFieldOrder" value="0"></div>' +
'<div class="form-row form-row-inline"><input type="checkbox" id="pFieldActive" checked><label>Visible on site</label></div>' +
'<div class="modal-actions"><button class="btn" onclick="closePlanForm()">Cancel</button><button class="btn btn-primary" onclick="savePlan()">Save Plan</button></div>' +
'</div></div>' +
'<script>' +
'var categories=[];' +
'function doLogin(){' +
'var pw=document.getElementById("loginPassword").value;' +
'fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"include",body:JSON.stringify({password:pw})})' +
'.then(function(r){return r.json();}).then(function(d){' +
'if(d.ok){document.getElementById("loginScreen").style.display="none";document.getElementById("dashboard").style.display="block";loadAll();}' +
'else{document.getElementById("loginError").style.display="block";}' +
'});}' +
'function loadAll(){loadMockups();loadCategories();loadTutorials();loadPlans();loadOrders();loadSettings();}' +
'function showTab(name,btn){' +
'document.querySelectorAll(".tab").forEach(function(t){t.classList.remove("active");});' +
'document.querySelectorAll(".panel").forEach(function(p){p.classList.remove("active");});' +
'btn.classList.add("active");document.getElementById("panel-"+name).classList.add("active");}' +
'function loadMockups(){' +
'fetch("/api/mockups",{credentials:"include"}).then(function(r){return r.json();}).then(function(data){' +
'var tbody=document.getElementById("mockupsTableBody");' +
'document.getElementById("mockupCount").textContent=data.length+" mockups";' +
'if(!data.length){tbody.innerHTML="<tr class=\'empty-row\'><td colspan=\'6\'>No mockups yet.</td></tr>";return;}' +
'tbody.innerHTML=data.map(function(m){' +
'var thumb=m.image_url&&m.image_url.indexOf("http")===0?' +
'"<img class=\'thumb-img\' src=\'"+m.image_url+"\' onerror=\'this.style.display=\\\"none\\\"\' loading=\'lazy\'>"' +
':"<div class=\'thumb-empty\'>&#128247;</div>";' +
'return "<tr><td>"+thumb+"</td><td><strong>"+esc(m.name_en)+"</strong><div style=\'font-size:.75rem;color:rgba(255,255,255,.4);margin-top:2px\'>"+esc(m.name_fa||"")+"</div></td>"' +
'+"<td>"+esc(m.category||"&#8212;")+"</td>"' +
'+"<td>"+(m.is_free?"<span class=\'badge free\'>Free</span>":"<span class=\'badge paid\'>$"+m.price+"</span>")+"</td>"' +
'+"<td><span class=\'badge "+(m.is_active?"yes":"no")+"\'>"+(m.is_active?"Yes":"No")+"</span></td>"' +
'+"<td style=\'white-space:nowrap\'><button class=\'btn btn-edit btn-sm\' onclick=\'editMockup("+JSON.stringify(m)+")\'>Edit</button> <button class=\'btn btn-danger btn-sm\' onclick=\'deleteMockup("+m.id+")\'>Del</button></td></tr>";' +
'}).join("");});' +
'}' +
'function loadCategories(){' +
'fetch("/api/categories",{credentials:"include"}).then(function(r){return r.json();}).then(function(data){' +
'categories=data;renderCatChips();populateCatSelect();});' +
'}' +
'function renderCatChips(){' +
'var list=document.getElementById("catList");' +
'if(!categories.length){list.innerHTML="<span style=\'font-size:.8rem;color:rgba(255,255,255,.3)\'>No categories yet.</span>";return;}' +
'list.innerHTML=categories.map(function(c){' +
'return "<div class=\'cat-chip\'>"+esc(c.name_en)+" / <span style=\'color:rgba(255,255,255,.5)\'>"+esc(c.name_fa||"")+"</span><button onclick=\'deleteCategory("+c.id+")\'>&#215;</button></div>";' +
'}).join("");}' +
'function populateCatSelect(){' +
'var sel=document.getElementById("mFieldCat");var cur=sel.value;' +
'sel.innerHTML=categories.map(function(c){return "<option value=\'"+esc(c.name_en)+"\'>"+esc(c.name_en)+" / "+esc(c.name_fa||"")+"</option>";}).join("");' +
'if(cur)sel.value=cur;}' +
'function addCategory(){' +
'var en=document.getElementById("newCatEn").value.trim();' +
'var fa=document.getElementById("newCatFa").value.trim();' +
'if(!en){alert("English name required");return;}' +
'fetch("/api/categories",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"include",body:JSON.stringify({name_en:en,name_fa:fa})})' +
'.then(function(){document.getElementById("newCatEn").value="";document.getElementById("newCatFa").value="";loadCategories();});}' +
'function deleteCategory(id){' +
'if(!confirm("Delete this category?"))return;' +
'fetch("/api/categories/"+id,{method:"DELETE",credentials:"include"}).then(loadCategories);}' +
'function openMockupForm(){' +
'document.getElementById("mockupModalTitle").textContent="Add Mockup";' +
'document.getElementById("mockupId").value="";' +
'["mFieldEn","mFieldFa","mFieldDescEn","mFieldDescFa","mFieldImage","mFieldDownload"].forEach(function(id){document.getElementById(id).value="";});' +
'document.getElementById("mFieldGalleryImages").value="[]";' +
'document.getElementById("mFieldFree").checked=false;' +
'document.getElementById("mFieldPrice").value=25;' +
'document.getElementById("mFieldActive").checked=true;' +
'document.getElementById("imgPreview").style.display="none";' +
'togglePriceField();populateCatSelect();' +
'document.getElementById("mockupModalOverlay").classList.add("open");}' +
'function editMockup(m){' +
'document.getElementById("mockupModalTitle").textContent="Edit Mockup";' +
'document.getElementById("mockupId").value=m.id;' +
'document.getElementById("mFieldEn").value=m.name_en||"";' +
'document.getElementById("mFieldFa").value=m.name_fa||"";' +
'document.getElementById("mFieldDescEn").value=m.description_en||"";' +
'document.getElementById("mFieldDescFa").value=m.description_fa||"";' +
'document.getElementById("mFieldGalleryImages").value=m.gallery_images_json||"[]";' +
'document.getElementById("mFieldFree").checked=!!m.is_free;' +
'document.getElementById("mFieldPrice").value=m.price||25;' +
'document.getElementById("mFieldImage").value=m.image_url||"";' +
'document.getElementById("mFieldDownload").value=m.download_url||"";' +
'document.getElementById("mFieldActive").checked=!!m.is_active;' +
'togglePriceField();populateCatSelect();' +
'document.getElementById("mFieldCat").value=m.category||"";' +
'previewImg(m.image_url||"");' +
'document.getElementById("mockupModalOverlay").classList.add("open");}' +
'function closeMockupForm(){document.getElementById("mockupModalOverlay").classList.remove("open");}' +
'function togglePriceField(){document.getElementById("priceRow").style.display=document.getElementById("mFieldFree").checked?"none":"block";}' +
'function previewImg(url){var img=document.getElementById("imgPreview");if(url&&url.indexOf("http")===0){img.src=url;img.style.display="block";}else{img.style.display="none";}}' +
'function saveMockup(){' +
'var id=document.getElementById("mockupId").value;' +
'var isFree=document.getElementById("mFieldFree").checked;' +
'var price=parseFloat(document.getElementById("mFieldPrice").value)||0;' +
'var nameEn=document.getElementById("mFieldEn").value.trim();' +
'if(!nameEn){alert("English name is required.");return;}' +
'if(!isFree&&price<20){alert("Paid mockups must be $20 or more.");return;}' +
'var galleryImagesRaw=document.getElementById("mFieldGalleryImages").value.trim()||"[]";' +
'try{var parsedGallery=JSON.parse(galleryImagesRaw);if(!Array.isArray(parsedGallery))throw new Error("not array");}catch(e){alert("Gallery Images field must be a valid JSON array of URLs.");return;}' +
'var payload={name_en:nameEn,name_fa:document.getElementById("mFieldFa").value,category:document.getElementById("mFieldCat").value,is_free:isFree,price:isFree?0:price,image_url:document.getElementById("mFieldImage").value,download_url:document.getElementById("mFieldDownload").value,is_active:document.getElementById("mFieldActive").checked,description_en:document.getElementById("mFieldDescEn").value,description_fa:document.getElementById("mFieldDescFa").value,gallery_images_json:galleryImagesRaw,icon:"ti-box"};' +
'var url=id?"/api/mockups/"+id:"/api/mockups";' +
'var method=id?"PUT":"POST";' +
'fetch(url,{method:method,headers:{"Content-Type":"application/json"},credentials:"include",body:JSON.stringify(payload)})' +
'.then(function(){closeMockupForm();loadMockups();});}' +
'function deleteMockup(id){if(!confirm("Delete this mockup?"))return;fetch("/api/mockups/"+id,{method:"DELETE",credentials:"include"}).then(loadMockups);}' +
'function parseCsv(text){' +
'var lines=text.replace(/\\r\\n/g,"\\n").split("\\n").filter(function(l){return l.trim().length>0;});' +
'if(lines.length<2)return{header:[],rows:[]};' +
'function splitLine(line){' +
'var result=[];var cur="";var inQuotes=false;' +
'for(var i=0;i<line.length;i++){' +
'var ch=line[i];' +
'if(ch===\'"\'){' +
'if(inQuotes&&line[i+1]===\'"\'){cur+=\'"\';i++;}' +
'else{inQuotes=!inQuotes;}' +
'}else if(ch===\',\'&&!inQuotes){' +
'result.push(cur);cur="";' +
'}else{' +
'cur+=ch;' +
'}' +
'}' +
'result.push(cur);' +
'return result.map(function(s){return s.trim();});' +
'}' +
'var header=splitLine(lines[0]);' +
'var rows=[];' +
'for(var i=1;i<lines.length;i++){' +
'var cols=splitLine(lines[i]);' +
'var obj={};' +
'for(var j=0;j<header.length;j++){obj[header[j]]=cols[j]!==undefined?cols[j]:"";}' +
'rows.push(obj);' +
'}' +
'return{header:header,rows:rows};' +
'}' +
'function openBulkImportForm(){' +
'document.getElementById("bulkCsvInput").value="";' +
'document.getElementById("bulkImportPreview").textContent="";' +
'document.getElementById("bulkImportErrors").textContent="";' +
'document.getElementById("bulkImportModalOverlay").classList.add("open");}' +
'function closeBulkImportForm(){document.getElementById("bulkImportModalOverlay").classList.remove("open");}' +
'function submitBulkImport(){' +
'var text=document.getElementById("bulkCsvInput").value.trim();' +
'var errBox=document.getElementById("bulkImportErrors");' +
'var previewBox=document.getElementById("bulkImportPreview");' +
'errBox.textContent="";' +
'if(!text){errBox.textContent="Paste CSV content first.";return;}' +
'var parsed=parseCsv(text);' +
'if(!parsed.rows.length){errBox.textContent="No data rows found (need a header row plus at least one data row).";return;}' +
'if(parsed.header.indexOf("name_en")===-1){errBox.textContent="CSV header must include a name_en column.";return;}' +
'previewBox.textContent=parsed.rows.length+" rows detected. Importing...";' +
'fetch("/api/mockups/bulk-import",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"include",body:JSON.stringify({rows:parsed.rows})})' +
'.then(function(r){return r.json().then(function(d){return{status:r.status,body:d};});})' +
'.then(function(res){' +
'if(res.status!==200){' +
'previewBox.textContent="";' +
'errBox.textContent=(res.body.error||"Import failed")+(res.body.details?"\\n\\n"+res.body.details.join("\\n"):"");' +
'return;' +
'}' +
'previewBox.textContent="Imported "+res.body.imported+" mockups successfully.";' +
'loadMockups();' +
'setTimeout(closeBulkImportForm,1200);' +
'})' +
'.catch(function(e){errBox.textContent="Network error: "+e.message;});' +
'}' +
'function loadTutorials(){' +
'fetch("/api/tutorials",{credentials:"include"}).then(function(r){return r.json();}).then(function(data){' +
'var tbody=document.getElementById("tutorialsTableBody");' +
'document.getElementById("tutorialCount").textContent=data.length+" tutorials";' +
'if(!data.length){tbody.innerHTML="<tr class=\'empty-row\'><td colspan=\'7\'>No tutorials yet.</td></tr>";return;}' +
'tbody.innerHTML=data.map(function(t){' +
'var thumb=t.image_url&&t.image_url.indexOf("http")===0?' +
'"<img class=\'thumb-img\' src=\'"+t.image_url+"\' onerror=\'this.style.display=\\\"none\\\"\' loading=\'lazy\'>"' +
':"<div class=\'thumb-empty\'>&#128218;</div>";' +
'return "<tr><td>"+thumb+"</td><td><strong>"+esc(t.title_en)+"</strong><div style=\'font-size:.75rem;color:rgba(255,255,255,.4);margin-top:2px\'>"+esc(t.title_fa||"")+"</div></td>"' +
'+"<td>"+esc(t.level||"&#8212;")+"</td>"' +
'+"<td>"+esc(t.type||"&#8212;")+"</td>"' +
'+"<td>"+(t.order_index||0)+"</td>"' +
'+"<td><span class=\'badge "+(t.is_active?"yes":"no")+"\'>"+(t.is_active?"Yes":"No")+"</span></td>"' +
'+"<td style=\'white-space:nowrap\'><button class=\'btn btn-edit btn-sm\' onclick=\'editTutorial("+JSON.stringify(t)+")\'>Edit</button> <button class=\'btn btn-danger btn-sm\' onclick=\'deleteTutorial("+t.id+")\'>Del</button></td></tr>";' +
'}).join("");});' +
'}' +
'function openTutorialForm(){' +
'document.getElementById("tutorialModalTitle").textContent="Add Tutorial";' +
'document.getElementById("tutorialId").value="";' +
'["tFieldTitleEn","tFieldTitleFa","tFieldIntroEn","tFieldIntroFa","tFieldDurationEn","tFieldDurationFa","tFieldImage","tFieldVideoUrl","tFieldTipEn","tFieldTipFa"].forEach(function(id){document.getElementById(id).value="";});' +
'document.getElementById("tFieldIcon").value="ti-books";' +
'document.getElementById("tFieldLevel").value="beginner";' +
'document.getElementById("tFieldType").value="video";' +
'document.getElementById("tFieldSections").value="[]";' +
'document.getElementById("tFieldOrder").value=0;' +
'document.getElementById("tFieldActive").checked=true;' +
'document.getElementById("tutorialImgPreview").style.display="none";' +
'document.getElementById("tutorialModalOverlay").classList.add("open");}' +
'function editTutorial(t){' +
'document.getElementById("tutorialModalTitle").textContent="Edit Tutorial";' +
'document.getElementById("tutorialId").value=t.id;' +
'document.getElementById("tFieldTitleEn").value=t.title_en||"";' +
'document.getElementById("tFieldTitleFa").value=t.title_fa||"";' +
'document.getElementById("tFieldIntroEn").value=t.intro_en||"";' +
'document.getElementById("tFieldIntroFa").value=t.intro_fa||"";' +
'document.getElementById("tFieldLevel").value=t.level||"beginner";' +
'document.getElementById("tFieldType").value=t.type||"video";' +
'document.getElementById("tFieldDurationEn").value=t.duration_en||"";' +
'document.getElementById("tFieldDurationFa").value=t.duration_fa||"";' +
'document.getElementById("tFieldIcon").value=t.icon||"ti-books";' +
'document.getElementById("tFieldImage").value=t.image_url||"";' +
'document.getElementById("tFieldVideoUrl").value=t.video_url||"";' +
'document.getElementById("tFieldSections").value=t.sections_json||"[]";' +
'document.getElementById("tFieldTipEn").value=t.tip_en||"";' +
'document.getElementById("tFieldTipFa").value=t.tip_fa||"";' +
'document.getElementById("tFieldOrder").value=t.order_index||0;' +
'document.getElementById("tFieldActive").checked=!!t.is_active;' +
'previewTutorialImg(t.image_url||"");' +
'document.getElementById("tutorialModalOverlay").classList.add("open");}' +
'function closeTutorialForm(){document.getElementById("tutorialModalOverlay").classList.remove("open");}' +
'function previewTutorialImg(url){var img=document.getElementById("tutorialImgPreview");if(url&&url.indexOf("http")===0){img.src=url;img.style.display="block";}else{img.style.display="none";}}' +
'function saveTutorial(){' +
'var id=document.getElementById("tutorialId").value;' +
'var titleEn=document.getElementById("tFieldTitleEn").value.trim();' +
'if(!titleEn){alert("English title is required.");return;}' +
'var sectionsRaw=document.getElementById("tFieldSections").value.trim()||"[]";' +
'try{JSON.parse(sectionsRaw);}catch(e){alert("Sections field must be valid JSON.");return;}' +
'var payload={' +
'title_en:titleEn,' +
'title_fa:document.getElementById("tFieldTitleFa").value,' +
'intro_en:document.getElementById("tFieldIntroEn").value,' +
'intro_fa:document.getElementById("tFieldIntroFa").value,' +
'level:document.getElementById("tFieldLevel").value,' +
'type:document.getElementById("tFieldType").value,' +
'duration_en:document.getElementById("tFieldDurationEn").value,' +
'duration_fa:document.getElementById("tFieldDurationFa").value,' +
'icon:document.getElementById("tFieldIcon").value||"ti-books",' +
'image_url:document.getElementById("tFieldImage").value,' +
'video_url:document.getElementById("tFieldVideoUrl").value,' +
'sections_json:sectionsRaw,' +
'tip_en:document.getElementById("tFieldTipEn").value,' +
'tip_fa:document.getElementById("tFieldTipFa").value,' +
'order_index:parseInt(document.getElementById("tFieldOrder").value,10)||0,' +
'is_active:document.getElementById("tFieldActive").checked' +
'};' +
'var url=id?"/api/tutorials/"+id:"/api/tutorials";' +
'var method=id?"PUT":"POST";' +
'fetch(url,{method:method,headers:{"Content-Type":"application/json"},credentials:"include",body:JSON.stringify(payload)})' +
'.then(function(){closeTutorialForm();loadTutorials();});}' +
'function deleteTutorial(id){if(!confirm("Delete this tutorial?"))return;fetch("/api/tutorials/"+id,{method:"DELETE",credentials:"include"}).then(loadTutorials);}' +
'function loadPlans(){' +
'fetch("/api/plans",{credentials:"include"}).then(function(r){return r.json();}).then(function(data){' +
'var tbody=document.getElementById("plansTableBody");' +
'document.getElementById("planCount").textContent=data.length+" plans";' +
'if(!data.length){tbody.innerHTML="<tr class=\'empty-row\'><td colspan=\'8\'>No plans yet.</td></tr>";return;}' +
'tbody.innerHTML=data.map(function(p){' +
'return "<tr><td>"+esc(p.tag_en||"&#8212;")+"</td><td><strong>"+esc(p.name)+"</strong></td><td>$"+(p.price||0)+"</td>"' +
'+"<td><span class=\'badge "+(p.is_best?"yes":"no")+"\'>"+(p.is_best?"Yes":"No")+"</span></td>"' +
'+"<td><span class=\'badge "+(p.is_disabled?"no":"yes")+"\'>"+(p.is_disabled?"Disabled":"Enabled")+"</span></td>"' +
'+"<td>"+(p.order_index||0)+"</td>"' +
'+"<td><span class=\'badge "+(p.is_active?"yes":"no")+"\'>"+(p.is_active?"Yes":"No")+"</span></td>"' +
'+"<td style=\'white-space:nowrap\'><button class=\'btn btn-edit btn-sm\' onclick=\'editPlan("+JSON.stringify(p)+")\'>Edit</button> <button class=\'btn btn-danger btn-sm\' onclick=\'deletePlan("+p.id+")\'>Del</button></td></tr>";' +
'}).join("");});' +
'}' +
'function openPlanForm(){' +
'document.getElementById("planModalTitle").textContent="Add Plan";' +
'document.getElementById("planId").value="";' +
'["pFieldName","pFieldTagEn","pFieldTagFa","pFieldBtnEn","pFieldBtnFa"].forEach(function(id){document.getElementById(id).value="";});' +
'document.getElementById("pFieldTagIcon").value="ti-coffee";' +
'document.getElementById("pFieldPrice").value=0;' +
'document.getElementById("pFieldPeriodEn").value="/mo";' +
'document.getElementById("pFieldPeriodFa").value="/ماه";' +
'document.getElementById("pFieldFeatures").value="[]";' +
'document.getElementById("pFieldBtnEn").value="Coming Soon";' +
'document.getElementById("pFieldBtnFa").value="به‌زودی";' +
'document.getElementById("pFieldDisabled").checked=true;' +
'document.getElementById("pFieldBest").checked=false;' +
'document.getElementById("pFieldOrder").value=0;' +
'document.getElementById("pFieldActive").checked=true;' +
'document.getElementById("planModalOverlay").classList.add("open");}' +
'function editPlan(p){' +
'document.getElementById("planModalTitle").textContent="Edit Plan";' +
'document.getElementById("planId").value=p.id;' +
'document.getElementById("pFieldName").value=p.name||"";' +
'document.getElementById("pFieldTagEn").value=p.tag_en||"";' +
'document.getElementById("pFieldTagFa").value=p.tag_fa||"";' +
'document.getElementById("pFieldTagIcon").value=p.tag_icon||"ti-coffee";' +
'document.getElementById("pFieldPrice").value=p.price||0;' +
'document.getElementById("pFieldPeriodEn").value=p.period_en||"/mo";' +
'document.getElementById("pFieldPeriodFa").value=p.period_fa||"/ماه";' +
'document.getElementById("pFieldFeatures").value=p.features_json||"[]";' +
'document.getElementById("pFieldBtnEn").value=p.button_label_en||"Coming Soon";' +
'document.getElementById("pFieldBtnFa").value=p.button_label_fa||"به‌زودی";' +
'document.getElementById("pFieldDisabled").checked=!!p.is_disabled;' +
'document.getElementById("pFieldBest").checked=!!p.is_best;' +
'document.getElementById("pFieldOrder").value=p.order_index||0;' +
'document.getElementById("pFieldActive").checked=!!p.is_active;' +
'document.getElementById("planModalOverlay").classList.add("open");}' +
'function closePlanForm(){document.getElementById("planModalOverlay").classList.remove("open");}' +
'function savePlan(){' +
'var id=document.getElementById("planId").value;' +
'var name=document.getElementById("pFieldName").value.trim();' +
'if(!name){alert("Plan name is required.");return;}' +
'var featuresRaw=document.getElementById("pFieldFeatures").value.trim()||"[]";' +
'try{JSON.parse(featuresRaw);}catch(e){alert("Features field must be valid JSON.");return;}' +
'var payload={' +
'name:name,' +
'tag_en:document.getElementById("pFieldTagEn").value,' +
'tag_fa:document.getElementById("pFieldTagFa").value,' +
'tag_icon:document.getElementById("pFieldTagIcon").value||"ti-coffee",' +
'price:parseFloat(document.getElementById("pFieldPrice").value)||0,' +
'period_en:document.getElementById("pFieldPeriodEn").value,' +
'period_fa:document.getElementById("pFieldPeriodFa").value,' +
'features_json:featuresRaw,' +
'button_label_en:document.getElementById("pFieldBtnEn").value,' +
'button_label_fa:document.getElementById("pFieldBtnFa").value,' +
'is_disabled:document.getElementById("pFieldDisabled").checked,' +
'is_best:document.getElementById("pFieldBest").checked,' +
'order_index:parseInt(document.getElementById("pFieldOrder").value,10)||0,' +
'is_active:document.getElementById("pFieldActive").checked' +
'};' +
'var url=id?"/api/plans/"+id:"/api/plans";' +
'var method=id?"PUT":"POST";' +
'fetch(url,{method:method,headers:{"Content-Type":"application/json"},credentials:"include",body:JSON.stringify(payload)})' +
'.then(function(){closePlanForm();loadPlans();});}' +
'function deletePlan(id){if(!confirm("Delete this plan?"))return;fetch("/api/plans/"+id,{method:"DELETE",credentials:"include"}).then(loadPlans);}' +
'function loadOrders(){' +
'fetch("/api/orders",{credentials:"include"}).then(function(r){return r.json();}).then(function(data){' +
'var tbody=document.getElementById("ordersTableBody");' +
'if(!data.length){tbody.innerHTML="<tr class=\'empty-row\'><td colspan=\'7\'>No orders yet.</td></tr>";return;}' +
'tbody.innerHTML=data.map(function(o){return "<tr><td style=\'font-family:monospace;font-size:.75rem\'>"+esc(o.order_id||"")+"</td><td>"+esc(o.customer_email||"&#8212;")+"</td><td>"+esc(o.mockup_name||"&#8212;")+"</td><td>$"+(o.amount_usd||0)+"</td><td>"+esc(o.pay_currency||"&#8212;")+"</td><td><span class=\'badge status-"+(o.status||"")+"\'>"+(o.status||"&#8212;")+"</span></td><td style=\'font-size:.75rem\'>"+esc(o.created_at||"")+"</td></tr>";}).join("");});' +
'}' +
'function loadSettings(){' +
'fetch("/api/settings",{credentials:"include"}).then(function(r){return r.json();}).then(function(data){' +
'var list=document.getElementById("settingsList");' +
'if(!data.length){list.innerHTML="<p style=\'color:rgba(255,255,255,.3);font-size:.85rem\'>No settings yet.</p>";return;}' +
'list.innerHTML=data.map(function(s){return "<div class=\'settings-row\'><span style=\'font-size:.85rem\'>"+esc(s.key)+"</span><input value=\'"+esc(s.value||"")+"\'onchange=\'saveSetting(\'"+esc(s.key)+"\',this.value)\'></div>";}).join("");});' +
'}' +
'function saveSetting(key,value){fetch("/api/settings",{method:"POST",headers:{"Content-Type":"application/json"},credentials:"include",body:JSON.stringify({key:key,value:value})});}' +
'function esc(str){return String(str||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}' +
'<\/script>' +
'</body></html>';
}
