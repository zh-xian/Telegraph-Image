// netlify/functions/upload.js
// Node 18+ runtime on Netlify: global fetch, FormData, Blob 支持
const MAX_BYTES = 4.5 * 1024 * 1024; // 安全线（Base64 编码后 30% 开销 -> Netlify 6MB 上限）

exports.handler = async (event) => {
  // CORS preflight
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers: corsHeaders(),
      body: "",
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers: corsHeaders(),
      body: JSON.stringify({ error: "Method Not Allowed" }),
    };
  }

  try {
    const contentType = event.headers["content-type"] || event.headers["Content-Type"] || "";
    // 支持 application/json（推荐）——传 fileBase64
    let payload;
    if (contentType.includes("application/json") || !contentType) {
      payload = JSON.parse(event.body || "{}");
    } else {
      // 其它 Content-Types 不支持
      return {
        statusCode: 415,
        headers: corsHeaders(),
        body: JSON.stringify({ error: "Unsupported Content-Type. Send JSON with fileBase64." }),
      };
    }

    const { fileBase64, filename, asPhoto } = payload;
    if (!fileBase64) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ error: "Missing fileBase64" }),
      };
    }

    // 清理 dataURL 前缀（如果有）
    const cleaned = fileBase64.includes(",") ? fileBase64.split(",")[1] : fileBase64;
    const buffer = Buffer.from(cleaned, "base64");

    if (buffer.byteLength > MAX_BYTES) {
      return {
        statusCode: 413,
        headers: corsHeaders(),
        body: JSON.stringify({ error: `File too large for Netlify Functions (>${Math.round(MAX_BYTES/1024/1024)}MB).` }),
      };
    }

    // 支持多种环境变量命名（兼容 README 中大小写差异）
    const TG_TOKEN =
      process.env.TG_BOT_TOKEN ||
      process.env.TG_Bot_Token ||
      process.env.TELEGRAM_BOT_TOKEN ||
      process.env.BOT_TOKEN;
    const TG_CHAT_ID =
      process.env.TG_CHAT_ID ||
      process.env.TG_Chat_ID ||
      process.env.TELEGRAM_CHAT_ID ||
      process.env.CHAT_ID;

    if (!TG_TOKEN || !TG_CHAT_ID) {
      return {
        statusCode: 500,
        headers: corsHeaders(),
        body: JSON.stringify({ error: "TG_BOT_TOKEN or TG_CHAT_ID not set in environment variables" }),
      };
    }

    // 构建 form data，调用 sendDocument 或 sendPhoto
    const form = new FormData();
    form.append("chat_id", String(TG_CHAT_ID));
    const fieldName = asPhoto ? "photo" : "document";
    // filename 回退
    const name = filename || `upload_${Date.now()}.bin`;
    // Blob 来自 Node 18+
    form.append(fieldName, new Blob([buffer]), name);

    const method = "POST";
    const sendUrl = `https://api.telegram.org/bot${TG_TOKEN}/${asPhoto ? "sendPhoto" : "sendDocument"}`;
    const sendResp = await fetch(sendUrl, { method, body: form });

    const sendJson = await sendResp.json().catch(() => ({}));
    if (!sendResp.ok || !sendJson?.ok) {
      return {
        statusCode: 502,
        headers: corsHeaders(),
        body: JSON.stringify({ error: "Telegram upload failed", detail: sendJson }),
      };
    }

    // 取出 file_id（photo 返回数组，document 返回对象）
    let file_id;
    if (sendJson.result.document) {
      file_id = sendJson.result.document.file_id;
    } else if (sendJson.result.photo && Array.isArray(sendJson.result.photo)) {
      // photo 数组，最后一个通常为最大尺寸
      const arr = sendJson.result.photo;
      file_id = arr[arr.length - 1].file_id;
    } else if (sendJson.result.sticker) {
      file_id = sendJson.result.sticker.file_id;
    }

    if (!file_id) {
      // 若没有 file_id，仍然返回 sendJson 以便排查
      return {
        statusCode: 502,
        headers: corsHeaders(),
        body: JSON.stringify({ error: "No file_id returned from Telegram", detail: sendJson }),
      };
    }

    // 调用 getFile 获取 file_path，再构造可下载直链
    const getFileResp = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/getFile?file_id=${file_id}`);
    const getFileJson = await getFileResp.json().catch(() => ({}));
    if (!getFileResp.ok || !getFileJson?.ok || !getFileJson.result?.file_path) {
      return {
        statusCode: 502,
        headers: corsHeaders(),
        body: JSON.stringify({ error: "Failed to get file info from Telegram", detail: getFileJson }),
      };
    }

    const file_path = getFileJson.result.file_path;
    const file_url = `https://api.telegram.org/file/bot${TG_TOKEN}/${file_path}`;

    // 返回给前端
    return {
      statusCode: 200,
      headers: corsHeaders(),
      body: JSON.stringify({
        ok: true,
        backend: "telegram",
        url: file_url,
        file_id,
        message_id: sendJson.result?.message_id,
      }),
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({ error: err?.message || String(err) }),
    };
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json; charset=utf-8",
  };
}
