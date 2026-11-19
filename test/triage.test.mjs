import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createAppServer, triage, MODEL_TIMEOUT_MS } from "../server.mjs";
import { viewFor, MESSAGES } from "../view.mjs";

const silent = { warn() {} };
let server;
let baseUrl;

before(async () => {
  server = createAppServer({ logger: silent });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((done) => server.close(done)));

async function postRaw(body) {
  const response = await fetch(`${baseUrl}/api/triage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  return { status: response.status, body: await response.json() };
}

const post = (payload) => postRaw(JSON.stringify(payload));
const MANUAL_REVIEW = { status: "manual_review", topic: null, draft: null };

describe("POST /api/triage — некорректный ввод → 400 invalid_input", () => {
  const cases = {
    "битый JSON": "{",
    "нет поля text": JSON.stringify({}),
    "пустая строка": JSON.stringify({ text: "" }),
    "только пробелы": JSON.stringify({ text: "   \n " }),
    "text не строка": JSON.stringify({ text: 42 }),
    "тело null": "null",
    "тело массив": JSON.stringify([{ text: "доставка" }]),
  };
  for (const [name, body] of Object.entries(cases)) {
    it(name, async () => {
      assert.deepEqual(await postRaw(body), { status: 400, body: { status: "invalid_input" } });
    });
  }
});

describe("POST /api/triage — успешный разбор → 200 ready", () => {
  it("определяет тему и возвращает непустой черновик", async () => {
    const { status, body } = await post({ text: "Когда будет доставка заказа?" });
    assert.equal(status, 200);
    assert.equal(body.status, "ready");
    assert.equal(body.topic, "delivery");
    assert.ok(body.draft.trim().length > 0);
  });

  it("тема pricing", async () => {
    const { body } = await post({ text: "Какая стоимость подписки?" });
    assert.equal(body.topic, "pricing");
  });
});

describe("POST /api/triage — сбой модели → 200 manual_review", () => {
  for (const marker of ["[error]", "[bad-json]", "[bad-topic]", "[empty-draft]"]) {
    it(marker, async () => {
      assert.deepEqual(await post({ text: `Заявка ${marker}` }), { status: 200, body: MANUAL_REVIEW });
    });
  }

  it("[timeout] — ответ приходит не позже лимита, а не через 1,2 с ожидания модели", async () => {
    const started = performance.now();
    const result = await post({ text: "Заявка [timeout]" });
    const elapsed = performance.now() - started;
    assert.deepEqual(result, { status: 200, body: MANUAL_REVIEW });
    assert.ok(elapsed < MODEL_TIMEOUT_MS + 300, `ответ занял ${Math.round(elapsed)} мс`);
  });

  it("по таймауту запрос к модели отменяется через signal", async () => {
    let receivedSignal;
    const slow = (_text, { signal }) => {
      receivedSignal = signal;
      return new Promise(() => {});
    };
    assert.deepEqual(await triage("текст", { classifyFn: slow, timeoutMs: 50, logger: silent }), MANUAL_REVIEW);
    assert.equal(receivedSignal.aborted, true);
  });

  it("модель, которая игнорирует signal и не отвечает, тоже обрывается по таймауту", async () => {
    const hanging = () => new Promise(() => {});
    assert.deepEqual(await triage("текст", { classifyFn: hanging, timeoutMs: 50, logger: silent }), MANUAL_REVIEW);
  });
});

describe("viewFor — что видит менеджер", () => {
  it("ready: показывает тему и черновик", () => {
    const view = viewFor(200, { status: "ready", topic: "delivery", draft: "Спасибо!" });
    assert.equal(view.kind, "ready");
    assert.match(view.message, /Доставка/);
    assert.equal(view.draft, "Спасибо!");
  });

  it("manual_review: понятное сообщение и пустой черновик", () => {
    const view = viewFor(200, MANUAL_REVIEW);
    assert.deepEqual(view, { kind: "manual_review", message: MESSAGES.manualReview, draft: "" });
  });

  it("ошибка сервера или сети: «сервис недоступен», черновик очищен", () => {
    for (const [status, body] of [[500, { status: "server_error" }], [0, null]]) {
      assert.deepEqual(viewFor(status, body), {
        kind: "service_unavailable",
        message: MESSAGES.serviceUnavailable,
        draft: "",
      });
    }
  });

  it("ready с пустым черновиком не показывается как готовый", () => {
    assert.equal(viewFor(200, { status: "ready", topic: "other", draft: "  " }).kind, "manual_review");
  });

  it("invalid_input: просит ввести текст", () => {
    assert.equal(viewFor(400, { status: "invalid_input" }).message, MESSAGES.invalidInput);
  });
});
