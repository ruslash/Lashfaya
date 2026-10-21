// Vercel Serverless Function: инициирует платёж в Т-Банке и возвращает PaymentURL.
// Секрет (пароль терминала) берётся из переменной окружения TBANK_PASSWORD — в коде его нет.
const crypto = require("crypto");

const TERMINAL_KEY = "1643112119445";
const INIT_URL = "https://securepay.tinkoff.ru/v2/Init";

const MIN_RUB = 100;        // минимальная сумма, ₽
const MAX_RUB = 1000000;    // максимальная сумма, ₽ (защита от лишних нулей)

// Токен (подпись) Т-Банка: берём подписываемые поля верхнего уровня + Password,
// сортируем ключи по алфавиту, склеиваем значения, считаем SHA-256.
function makeToken(fields, password) {
  const signable = { ...fields, Password: password };
  const concatenated = Object.keys(signable)
    .sort()
    .map((k) => signable[k])
    .join("");
  return crypto.createHash("sha256").update(concatenated).digest("hex");
}

async function readBody(req) {
  if (req.body) {
    if (typeof req.body === "string") {
      try { return JSON.parse(req.body); } catch { return {}; }
    }
    return req.body;
  }
  return await new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
    });
  });
}

module.exports = async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST") {
    res.statusCode = 405;
    return res.end(JSON.stringify({ error: "Method not allowed" }));
  }

  const password = (process.env.TBANK_PASSWORD || "").trim();
  if (!password) {
    res.statusCode = 500;
    return res.end(JSON.stringify({ error: "TBANK_PASSWORD не настроен на сервере" }));
  }

  const body = await readBody(req);

  // Сумма приходит в рублях из поля на странице.
  const rub = Math.round(Number(body.amount));
  if (!Number.isFinite(rub) || rub < MIN_RUB || rub > MAX_RUB) {
    res.statusCode = 400;
    return res.end(JSON.stringify({
      error: `Сумма должна быть от ${MIN_RUB} до ${MAX_RUB} ₽`,
    }));
  }

  const amountKopecks = rub * 100;
  const orderId = "lf-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);

  // Поля, которые участвуют в подписи (без вложенных объектов DATA/Receipt).
  const signableFields = {
    TerminalKey: TERMINAL_KEY,
    Amount: String(amountKopecks),
    OrderId: orderId,
    Description: "Оплата участия Л.Э.Ш. ФАЯ",
  };

  const token = makeToken(signableFields, password);

  const initPayload = {
    ...signableFields,
    Token: token,
    // Обязательно для корректной работы виджета (требование Т-Банка).
    DATA: { connection_type: "Widget" },
  };

  try {
    const tbResp = await fetch(INIT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initPayload),
    });
    const data = await tbResp.json();

    if (!data.Success || !data.PaymentURL) {
      res.statusCode = 502;
      return res.end(JSON.stringify({
        error: data.Message || data.Details || "Не удалось создать платёж",
        code: data.ErrorCode,
      }));
    }

    res.statusCode = 200;
    return res.end(JSON.stringify({ paymentUrl: data.PaymentURL }));
  } catch (e) {
    res.statusCode = 502;
    return res.end(JSON.stringify({ error: "Ошибка связи с Т-Банком" }));
  }
};
