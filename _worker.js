const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const isTruthy = v => v !== undefined && v !== null && String(v).toLowerCase() !== "false" && String(v) !== "";

function unauthorized() {
  return new Response("Unauthorized", {
    status: 401,
    headers: { "WWW-Authenticate": 'Basic realm="admin"', "cache-control": "no-store" },
  });
}

function badRequest(msg, code = 400) {
  return new Response(JSON.stringify({ error: msg }), { status: code, headers: JSON_HEADERS });
}

function okJSON(obj, code = 200) {
  return new Response(JSON.stringify(obj), { status: code, headers: JSON_HEADERS });
}

function basicOK(req, env) {
  if (!isTruthy(env.BASIC_USER) || !isTruthy(env.BASIC_PASS)) return true; // 未配置则不启用后台口令
  const auth = req.headers.get("authorization") || "";
  if (!auth.startsWith("Basic ")) return false;
  try {
    const [user, pass] = atob(auth.slice(6)).split(":");
    return user === env.BASIC_USER && pass === env.BASIC_PASS;
  } catch { return false; }
}

function shortId() {
  return (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/[^a-z0-9]/gi, "").slice(0, 16);
}

async function sendToTelegram(file, filename, env) {
  const token = env.TG_BOT_TOKEN, chat = env.TG_CHAT_ID;
  if (!isTruthy(token) || !isTruthy(chat)) throw new Error("Server not configured: TG_BOT_TOKEN / TG_CHAT_ID");

  // 走 sendDocument，保留原文件名；Cloudflare/EdgeOne 支持原生 FormData/File
  const form = new FormData();
  form.set("chat_id", String(chat));
  form.set("document", file, filename || file.name || "image");

  const res = await fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) throw new Error(data?.description || `Telegram sendDocument failed: ${res.status}`);

  const fileId = data.result?.document?.file_id || data.result?.document?.file_unique_id;
  if (!fileId) throw new Error("No file_id from Telegram");

  const gf = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const gfData = await gf.json().catch(() => ({}));
  if (!gf.ok || !gfData.ok) throw new Error(gfData?.description || `Telegram getFile failed: ${gf.status}`);

  return { file_id: fileId, file_path: gfData.result.file_path };
}

async function handleUpload(req, env) {
  const ct = req.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) return badRequest("expect multipart/form-data");

  const form = await req.formData();
  let file = form.get("file") || form.get("image") || form.get("photo");
  if (!file || typeof file.arrayBuffer !== "function") return badRequest("no file found in form field 'file'/'image'/'photo'");

  // Telegram 普通 bot 单文件上限 50MB；这里做一个保守检查
  const size = file.size ?? (await file.arrayBuffer()).byteLength;
  if (size > 45 * 1024 * 1024) return badRequest("file too large (>45MB)", 413);

  const { file_id, file_path } = await sendToTelegram(file, file.name, env);

  const id = shortId();
  const meta = {
    id,
    tg_file_id: file_id,
    tg_file_path: file_path,
    filename: file.name || "image",
    mime: file.type || "",
    size: size || 0,
    createdAt: Date.now(),
    ip: req.headers.get("cf-connecting-ip") || req.headers.get("x-forwarded-for") || "",
    ua: req.headers.get("user-agent") || "",
  };

  await env.img_url.put(`f:${id}`, JSON.stringify(meta));
  // 兼容原前端预期：返回一个可直接访问的 src
  const base = env.PUBLIC_BASE_URL || new URL(req.url).origin;
  return okJSON({ id, src: `${base}/file/${id}` });
}

async function proxyFile(id, env) {
  const meta = await env.img_url.get(`f:${id}`, "json");
  if (!meta || !meta.tg_file_path) return new Response("Not Found", { status: 404 });

  const url = `https://api.telegram.org/file/bot${env.TG_BOT_TOKEN}/${meta.tg_file_path}`;
  const res = await fetch(url, { method: "GET" });
  if (!res.ok) return new Response("Upstream Error", { status: 502 });

  // 透传内容类型，附带缓存头
  const headers = new Headers(res.headers);
  headers.set("cache-control", "public, max-age=31536000, immutable");
  if (!headers.has("content-disposition")) {
    const safe = meta.filename?.replace(/[^\w.\-]/g, "_") || `${id}.bin`;
    headers.set("content-disposition", `inline; filename="${safe}"`);
  }
  return new Response(res.body, { status: 200, headers });
}

async function adminList(req, env) {
  if (!basicOK(req, env)) return unauthorized();
  const url = new URL(req.url);
  const limit = Math.min(+url.searchParams.get("limit") || 50, 200);
  const cursor = url.searchParams.get("cursor") || undefined;

  const list = await env.img_url.list({ prefix: "f:", limit, cursor });
  const items = await Promise.all(
    (list.keys || []).map(async k => {
      const meta = await env.img_url.get(k.name, "json").catch(() => null);
      if (!meta) return null;
      return {
        id: meta.id,
        filename: meta.filename,
        size: meta.size,
        mime: meta.mime,
        createdAt: meta.createdAt,
        url: (env.PUBLIC_BASE_URL || new URL(req.url).origin) + "/file/" + meta.id,
      };
    })
  );
  return okJSON({ items: items.filter(Boolean), cursor: list.cursor || null, list_complete: list.list_complete });
}

async function adminDelete(req, env, id) {
  if (!basicOK(req, env)) return unauthorized();
  await env.img_url.delete(`f:${id}`);
  return okJSON({ ok: true });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;

    // 1) 后台页面强制 Basic Auth（启用后）
    if (p === "/admin" || p.startsWith("/admin/")) {
      if (!basicOK(req, env)) return unauthorized();
      // 交给静态资源层去返回 admin.html（EdgeOne/Pages 都能透传）
      return env.ASSETS ? env.ASSETS.fetch(req, env, ctx) : fetch(req);
    }

    // 2) 上传接口（兼容两种路径）
    if (req.method === "POST" && (p === "/upload" || p === "/api/upload")) {
      try { return await handleUpload(req, env); }
      catch (e) {
        return new Response(JSON.stringify({ error: String(e?.message || e) }), { status: 500, headers: JSON_HEADERS });
      }
    }

    // 3) 文件访问
    if (req.method === "GET" && p.startsWith("/file/")) {
      const id = p.split("/").pop();
      if (!id) return badRequest("missing id");
      return proxyFile(id, env);
    }

    // 4) 管理接口
    if (p === "/api/admin/list" && req.method === "GET") return adminList(req, env);
    if (p.startsWith("/api/admin/delete/") && req.method === "DELETE") {
      return adminDelete(req, env, p.split("/").pop());
    }

    // 5) 健康检查 & 关闭遥测提示
    if (p === "/api/ping") {
      return okJSON({ ok: true, ts: Date.now(), telemetry_disabled: !!isTruthy(env.disable_telemetry) });
    }

    // 6) 其他静态资源透传
    return env.ASSETS ? env.ASSETS.fetch(req, env, ctx) : fetch(req);
  }
};
