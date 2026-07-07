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

const DEFAULT_MODEL = "google/gemini-2.5-flash-image";
const ALLOWED_MODELS = [
  "google/gemini-2.5-flash-image",
  "bytedance-seed/seedream-4.5",
  "black-forest-labs/flux.2-pro",
  "openai/gpt-image-1",
];

Deno.serve(async (req) => {
  // preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const { prompt, imageDataUrl, model } = await req.json();

    if (!prompt || !imageDataUrl) {
      return new Response(
        JSON.stringify({ error: "Нужны оба поля: prompt и imageDataUrl" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    if (model && !ALLOWED_MODELS.includes(model)) {
      return new Response(
        JSON.stringify({ error: `Модель "${model}" не в списке разрешённых: ${ALLOWED_MODELS.join(", ")}` }),
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
        model: model || DEFAULT_MODEL,
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
