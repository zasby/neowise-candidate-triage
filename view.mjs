// Что показать менеджеру по ответу API. Общий модуль для страницы и тестов.
const TOPIC_LABELS = { delivery: "Доставка", pricing: "Цены и стоимость", other: "Другое" };

export const MESSAGES = {
  loading: "Разбираем заявку…",
  invalidInput: "Введите текст заявки — поле не может быть пустым.",
  manualReview: "AI не смог разобрать заявку. Разберите её вручную: тема не определена, черновик не сформирован.",
  serviceUnavailable: "Сервис недоступен. Разберите заявку вручную: черновик не сформирован.",
};

// status — HTTP-код ответа (0, если сеть недоступна), body — разобранный JSON или null.
export function viewFor(status, body) {
  if (status === 200 && body?.status === "ready" && typeof body.draft === "string" && body.draft.trim()) {
    return {
      kind: "ready",
      message: `Тема: ${TOPIC_LABELS[body.topic] ?? body.topic}`,
      draft: body.draft,
    };
  }
  if (status === 400 && body?.status === "invalid_input") {
    return { kind: "invalid_input", message: MESSAGES.invalidInput, draft: "" };
  }
  // Сервер недоступен или упал — это не ошибка AI, но заявку всё равно разбирают вручную.
  if (status === 0 || status >= 500) {
    return { kind: "service_unavailable", message: MESSAGES.serviceUnavailable, draft: "" };
  }
  // manual_review или неожиданный ответ — ручной разбор.
  return { kind: "manual_review", message: MESSAGES.manualReview, draft: "" };
}
