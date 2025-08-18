export async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Methods": "POST, OPTIONS"
      }
    }
  }

  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" }
  }

  try {
    const formData = JSON.parse(event.body)
    const { image } = formData // 前端传 base64

    if (!image) {
      return { statusCode: 400, body: "Missing image" }
    }

    // Telegraph API
    const response = await fetch("https://telegra.ph/upload", {
      method: "POST",
      body: formDataToBuffer(image),
      headers: {
        "Content-Type": "multipart/form-data; boundary=----WebKitFormBoundary"
      }
    })

    const result = await response.json()
    if (result.error) {
      return { statusCode: 500, body: JSON.stringify(result) }
    }

    return {
      statusCode: 200,
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({
        url: "https://telegra.ph" + result[0].src
      })
    }
  } catch (err) {
    return { statusCode: 500, body: err.toString() }
  }
}

// 把 base64 转换成 FormData
function formDataToBuffer(base64) {
  const boundary = "----WebKitFormBoundary"
  const data = Buffer.from(base64, "base64")

  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`
    ),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`)
  ])

  return body
}
