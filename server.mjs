import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classify } from "./mock-ai.mjs";

export const MODEL_TIMEOUT_MS = 300;
const MAX_BODY_BYTES = 64 * 1024;
const TOPICS = new Set(["delivery", "pricing", "other"]);

const html = await readFile(new URL("./index.html", import.meta.url));
const viewScript = await readFile(new URL("./view.mjs", import.meta.url));

const invalidInput = () => ({ status: "invalid_input" });
const manualReview = () => ({ status: "manual_review", topic: null, draft: null });

function json(response, status, body) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(body));
}

// Возвращает текст заявки или null, если ввод некорректный:
// битый JSON, не объект, нет поля text, не строка, пустая строка или слишком большое тело.
async function readText(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
  const text = body?.text;
  if (typeof text !== "string" || text.trim() === "") return null;
  return text;
}

// Проверка результата модели: валидный JSON, тема из списка, непустой черновик.
// Возвращает готовый ответ или причину, по которой нужен ручной разбор.
export function parseModelOutput(raw) {
  if (typeof raw !== "string") return { reason: "not_a_string" };
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { reason: "bad_json" };
  }
  if (!data || typeof data !== "object") return { reason: "not_an_object" };
  if (!TOPICS.has(data.topic)) return { reason: "unknown_topic" };
  if (typeof data.draft !== "string" || data.draft.trim() === "") return { reason: "empty_draft" };
  return { result: { status: "ready", topic: data.topic, draft: data.draft.trim() } };
}

// Вызов модели с ограничением ожидания. Любой сбой — таймаут, ошибка провайдера,
// неподходящий ответ — превращается в manual_review, а причина уходит в лог.
export async function triage(text, { classifyFn = classify, timeoutMs = MODEL_TIMEOUT_MS, logger = console } = {}) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("model_timeout"));
    }, timeoutMs);
  });
  try {
    // Promise.race страхует и от модели, которая игнорирует signal.
    const raw = await Promise.race([classifyFn(text, { signal: controller.signal }), timeout]);
    const { result, reason } = parseModelOutput(raw);
    if (result) return result;
    logger.warn(`[triage] manual_review: ${reason}`);
  } catch (error) {
    logger.warn(`[triage] manual_review: ${error?.message ?? "model_error"}`);
  } finally {
    clearTimeout(timer);
  }
  return manualReview();
}

export function createAppServer(options = {}) {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/") {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(html);
      return;
    }
    if (request.method === "GET" && request.url === "/view.mjs") {
      response.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8" });
      response.end(viewScript);
      return;
    }
    if (request.method !== "POST" || request.url !== "/api/triage") {
      return json(response, 404, { status: "not_found" });
    }
    try {
      const text = await readText(request);
      if (text === null) return json(response, 400, invalidInput());
      return json(response, 200, await triage(text, options));
    } catch {
      json(response, 500, { status: "server_error" });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createAppServer().listen(Number(process.env.PORT || 3000), "127.0.0.1");
}
