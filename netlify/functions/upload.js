export async function handler(event, context) {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: "Method not allowed" })
    };
  }

  try {
    const body = JSON.parse(event.body);
    const { image } = body;

    if (!image) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "No image provided" })
      };
    }

    // Telegraph API
    const res = await fetch("https://telegra.ph/upload", {
      method: "POST",
      body: buildFormData(image)
    });

    const data = await res.json();

    if (data.error) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: data.error })
      };
    }

    const url = "https://telegra.ph" + data[0].src;

    return {
      statusCode: 200,
      body: JSON.stringify({ url })
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
}

// 构造 form-data
function buildFormData(base64String) {
  const form = new FormData();
  const buffer = Buffer.from(base64String, "base64");
  form.append("file", buffer, "image.png");
  return form;
}