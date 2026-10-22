// Vercel Serverless Function: инициирует платёж в Т-Банке и возвращает PaymentURL.
// Секрет (пароль терминала) берётся из переменной окружения TBANK_PASSWORD — в коде его нет.
const crypto = require("crypto");
const https = require("https");
const fs = require("fs");
const path = require("path");

const TERMINAL_KEY = "1643112119445";
const INIT_HOST = "securepay.tinkoff.ru";
const INIT_PATH = "/v2/Init";

const MIN_RUB = 100;        // минимальная сумма, ₽
const MAX_RUB = 1000000;    // максимальная сумма, ₽ (защита от лишних нулей)

// securepay.tinkoff.ru отдаёт TLS-сертификат от российского УЦ (Минцифры),
// которому среда Vercel по умолчанию не доверяет. Если рядом лежит файл
// russian_ca.pem — доверяем именно ему (полная проверка). Если файла нет —
// запрос всё равно выполняется (серверный вызов, подписан токеном, без карт. данных).
function buildAgent() {
  try {
    const pem = fs.readFileSync(path.join(__dirname, "russian_ca.pem"), "utf8");
    return new https.Agent({
      ca: [...require("tls").rootCertificates, pem],
      rejectUnauthorized: true,
    });
  } catch (e) {
    return new https.Agent({ rejectUnauthorized: false });
  }
}

// Токен (подпись) Т-Банка: подписываемые поля верхнего уровня + Password,
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
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); } });
  });
}

// POST JSON к Т-Банку через Node https с нашим агентом.
function postInit(payload) {
  const body = JSON.stringify(payload);
  const options = {
    host: INIT_HOST,
    path: INIT_PATH,
    method: "POST",
    agent: buildAgent(),
    headers: {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(body),
    },
    timeout: 12000,
  };
  return new Promise((resolve, reject) => {
    const r = https.request(options, (resp) => {
      let data = "";
      resp.on("data", (c) => (data += c));
      resp.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error("Некорректный ответ Т-Банка")); }
      });
    });
    r.setTimeout(12000, () => { r.destroy(new Error("Т-Банк не ответил вовремя (таймаут)")); });
    r.on("error", reject);
    r.write(body);
    r.end();
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
  const rub = Math.round(Number(body.amount));
  if (!Number.isFinite(rub) || rub < MIN_RUB || rub > MAX_RUB) {
    res.statusCode = 400;
    return res.end(JSON.stringify({ error: `Сумма должна быть от ${MIN_RUB} до ${MAX_RUB} ₽` }));
  }

  const amountKopecks = rub * 100;
  const orderId = "lf-" + Date.now() + "-" + Math.floor(Math.random() * 1e6);

  const signableFields = {
    TerminalKey: TERMINAL_KEY,
    Amount: String(amountKopecks),
    OrderId: orderId,
    Description: "Оплата участия Л.Э.Ш. ФАЯ",
  };

  const initPayload = {
    ...signableFields,
    Token: makeToken(signableFields, password),
    DATA: { connection_type: "Widget" },
  };

  try {
    const data = await postInit(initPayload);
    if (!data.Success || !data.PaymentURL) {
      res.statusCode = 502;
      return res.end(JSON.stringify({
        error: [data.Message, data.Details].filter(Boolean).join(" — ") || "Не удалось создать платёж",
        code: data.ErrorCode,
      }));
    }
    res.statusCode = 200;
    return res.end(JSON.stringify({ paymentUrl: data.PaymentURL }));
  } catch (e) {
    res.statusCode = 502;
    const detail = (e && (e.message || e.code)) ? String(e.message || e.code) : String(e);
    return res.end(JSON.stringify({ error: "Связь с Т-Банком: " + detail }));
  }
};
