// Supabase Edge Function: sprite-proxy
// Асинхронная генерация: клиент шлёт { prompt, imageDataUrl, model } и сразу
// получает { job_id }, а сама генерация (может занимать больше минуты)
// продолжается в фоне через EdgeRuntime.waitUntil — так соединение с клиентом
// не держится открытым и мобильный браузер не обрывает его по таймауту.
// Результат/ошибка пишутся в таблицу public.sprite_jobs, клиент опрашивает её.
//
// Секреты функции: OPENROUTER_API_KEY (свой). SUPABASE_URL и
// SUPABASE_SERVICE_ROLE_KEY подставляются Supabase автоматически.

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const DEFAULT_MODEL = "openai/gpt-image-2";
const ALLOWED_MODELS = [
  "google/gemini-2.5-flash-image",
  "google/gemini-3.1-flash-lite-image",
  "google/gemini-3.1-flash-image",
  "openai/gpt-image-1-mini",
  "openai/gpt-5-image-mini",
  "openai/gpt-image-2",
  "openai/gpt-image-1",
];

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function jsonResponse(body: unknown, status: number) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function updateJob(jobId: string, fields: Record<string, unknown>) {
  await fetch(`${SUPABASE_URL}/rest/v1/sprite_jobs?id=eq.${jobId}`, {
    method: "PATCH",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(fields),
  });
}

async function processJob(jobId: string, prompt: string, imageDataUrl: string, model: string) {
  try {
    const apiKey = Deno.env.get("OPENROUTER_API_KEY");
    if (!apiKey) throw new Error("OPENROUTER_API_KEY не задан в секретах функции");

    const upstream = await fetch("https://openrouter.ai/api/v1/images", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        prompt,
        input_references: [
          { type: "image_url", image_url: { url: imageDataUrl } },
        ],
      }),
    });

    const raw = await upstream.text();
    if (!upstream.ok) throw new Error(raw);

    const data = JSON.parse(raw);
    const b64 =
      data?.data?.[0]?.b64_json ||
      data?.images?.[0]?.b64_json ||
      data?.images?.[0]?.image_url?.url ||
      data?.output?.[0]?.b64_json ||
      null;

    if (!b64) throw new Error("Не нашли картинку в ответе провайдера");

    await updateJob(jobId, { status: "done", result_b64: b64 });
  } catch (err) {
    await updateJob(jobId, { status: "error", error_message: String(err) });
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: CORS_HEADERS });
  }

  try {
    const { prompt, imageDataUrl, model } = await req.json();

    if (!prompt || !imageDataUrl) {
      return jsonResponse({ error: "Нужны оба поля: prompt и imageDataUrl" }, 400);
    }

    if (model && !ALLOWED_MODELS.includes(model)) {
      return jsonResponse(
        { error: `Модель "${model}" не в списке разрешённых: ${ALLOWED_MODELS.join(", ")}` },
        400
      );
    }

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/sprite_jobs`, {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({ status: "pending" }),
    });

    if (!insertRes.ok) {
      const errText = await insertRes.text();
      return jsonResponse({ error: `Не удалось создать задачу: ${errText}` }, 500);
    }

    const [job] = await insertRes.json();
    const jobId = job.id;

    // @ts-ignore EdgeRuntime доступен в среде выполнения Supabase Edge Functions
    EdgeRuntime.waitUntil(processJob(jobId, prompt, imageDataUrl, model || DEFAULT_MODEL));

    return jsonResponse({ job_id: jobId }, 202);

  } catch (err) {
    return jsonResponse({ error: String(err) }, 500);
  }
});
