// Supabase Edge Function: sprite-proxy
// Принимает { prompt, imageDataUrl } от клиента, сам стучится в OpenRouter
// (сервер-сервер запрос — CORS тут не при чём), и возвращает результат.
//
// Куда положить: Supabase Dashboard → Edge Functions → Deploy a new function → Via Editor
// Имя функции: sprite-proxy
// Секрет: Edge Functions → Manage secrets → добавить OPENROUTER_API_KEY = твой ключ

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req) => {
  // preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const { prompt, imageDataUrl } = await req.json();

    if (!prompt || !imageDataUrl) {
      return new Response(
        JSON.stringify({ error: "Нужны оба поля: prompt и imageDataUrl" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const apiKey = Deno.env.get("OPENROUTER_API_KEY");
    if (!apiKey) {
      return new Response(
        JSON.stringify({ error: "OPENROUTER_API_KEY не задан в секретах функции" }),
        { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    const upstream = await fetch("https://openrouter.ai/api/v1/images", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "openai/gpt-image-1",
        prompt,
        input_references: [
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      }),
    });

    const text = await upstream.text();

    return new Response(text, {
      status: upstream.status,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }
});
