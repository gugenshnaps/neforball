// Supabase Edge Function: sprite-proxy
// Асинхронная генерация: клиент шлёт { prompt, imageDataUrl, model } и сразу
// получает { job_id }, а сама генерация (может занимать больше минуты)
// продолжается в фоне через EdgeRuntime.waitUntil — так соединение с клиентом
// не держится открытым и мобильный браузер не обрывает его по таймауту.
// Результат/ошибка пишутся в таблицу public.sprite_jobs, клиент опрашивает её.
//
// Секреты функции: OPENROUTER_API_KEY и REMOVE_BG_API_KEY (свои). SUPABASE_URL и
// SUPABASE_SERVICE_ROLE_KEY подставляются Supabase автоматически.
//
// После генерации спрайт прогоняется через remove.bg (качественное вырезание
// фона) — так фон убирается стабильно у всех, а не через ненадёжный magenta-трюк.

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

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// вырезаем фон качественной моделью remove.bg, возвращаем чистый прозрачный PNG в base64.
// ВАЖНО: шлём бинарник (image_file), а не image_file_b64 — на спрайтах ~1.5МБ+
// base64-поле у remove.bg падает с "failed_to_read_image", бинарный путь работает
async function removeBg(rawB64: string): Promise<string> {
  const key = Deno.env.get("REMOVE_BG_API_KEY");
  if (!key) throw new Error("REMOVE_BG_API_KEY не задан в секретах функции");
  const form = new FormData();
  form.append("image_file", new Blob([base64ToBytes(rawB64)], { type: "image/png" }), "sprite.png");
  form.append("size", "auto");
  form.append("format", "png");
  const res = await fetch("https://api.remove.bg/v1.0/removebg", {
    method: "POST",
    headers: { "X-Api-Key": key },
    body: form,
  });
  if (!res.ok) {
    throw new Error("remove.bg " + res.status + ": " + (await res.text()).slice(0, 200));
  }
  return arrayBufferToBase64(await res.arrayBuffer());
}

// сохраняем готовый PNG в Storage прямо с сервера — телефону остаётся только
// короткая ссылка, никакой перекачки мегабайтов через мобильную сеть
// (именно она давала "Load failed" на последнем шаге создания аватара)
async function uploadSprite(jobId: string, b64: string): Promise<string> {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  const path = `sprites/${jobId}.png`;
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/nefory-photos/${path}`, {
    method: "POST",
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "image/png",
      "x-upsert": "true",
    },
    body: bytes,
  });
  if (!res.ok) {
    throw new Error("storage upload " + res.status + ": " + (await res.text()).slice(0, 200));
  }
  return `${SUPABASE_URL}/storage/v1/object/public/nefory-photos/${path}`;
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

    // вырезаем фон через remove.bg; при сбое не роняем всю генерацию —
    // отдаём сырой результат (лучше со фоном, чем ничего), а причину пишем
    // в bg_error, чтобы сбой был виден в базе, а не только в логах
    let finalB64 = b64.startsWith("data:") ? b64.split(",")[1] : b64;
    try {
      finalB64 = await removeBg(finalB64);
    } catch (e) {
      console.error("remove.bg не сработал, отдаю сырой спрайт:", e);
      await updateJob(jobId, { bg_error: String(e).slice(0, 500) });
    }

    // сохраняем в Storage на сервере; если вдруг не вышло — фолбэк на b64,
    // клиент умеет оба варианта
    try {
      const url = await uploadSprite(jobId, finalB64);
      await updateJob(jobId, { status: "done", result_url: url });
    } catch (e) {
      console.error("upload в Storage не сработал, отдаю b64:", e);
      await updateJob(jobId, { status: "done", result_b64: finalB64 });
    }
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
