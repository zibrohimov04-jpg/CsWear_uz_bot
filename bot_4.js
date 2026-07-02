const { Telegraf } = require('telegraf');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const { google } = require('googleapis');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SHOP_URL = process.env.SHOP_URL;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const PORT = process.env.PORT || 3000;
const SHEET_ID = process.env.SHEET_ID;
const SHEET_NAME = 'Заказы';

if (!BOT_TOKEN || !SHOP_URL || !OWNER_CHAT_ID) { console.error('Missing env vars'); process.exit(1); }

// ── STATUS CONFIG ──
const STATUS_CONFIG = {
  pending:     { label: 'Заказ получен',        emoji: '📋', sheetCol: null },
  confirmed:   { label: 'Оплата подтверждена',  emoji: '✅', sheetCol: 11 },
  shipped:     { label: 'Отправлен',            emoji: '📦', sheetCol: 12 },
  in_tashkent: { label: 'В Ташкенте',           emoji: '🏙', sheetCol: 13 },
  delivered:   { label: 'Доставлен',            emoji: '🎉', sheetCol: 14 }
};
const STATUS_FLOW = ['pending', 'confirmed', 'shipped', 'in_tashkent', 'delivered'];

// ── ORDER STORE ──
const ORDERS_FILE = './orders.json';
let orders = {};
try { if (fs.existsSync(ORDERS_FILE)) orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8')); }
catch (e) { console.log('Fresh order store'); }
function save() { try { fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2)); } catch (e) { console.error('Save error', e); } }

// ── GOOGLE SHEETS ──
let sheetsClient = null;
function tashkentTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  if (!process.env.GOOGLE_CREDENTIALS || !SHEET_ID) return null;
  try {
    const creds = JSON.parse(process.env.GOOGLE_CREDENTIALS);
    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    sheetsClient = google.sheets({ version: 'v4', auth });
    await ensureHeader();
    return sheetsClient;
  } catch (e) { console.error('Sheets init error:', e.message); return null; }
}

async function ensureHeader() {
  try {
    const res = await sheetsClient.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A1` });
    if (res.data.values?.[0]?.[0] === 'ID заказа') return;
    await sheetsClient.spreadsheets.values.update({
      spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A1`, valueInputOption: 'RAW',
      resource: { values: [['ID заказа','Дата заказа','Имя','Телефон','Telegram','Товары','Сумма (сум)','Карта','Комментарий','Статус','Оплата подтверждена','Отправлен','В Ташкенте','Доставлен']] }
    });
  } catch (e) { console.error('Header error:', e.message); }
}

async function appendToSheet(order) {
  const client = await getSheetsClient();
  if (!client) return;
  try {
    const items = order.items.map(i => `${i.name} [${i.size}] ×${i.qty}`).join(', ');
    await client.spreadsheets.values.append({
      spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:N`, valueInputOption: 'USER_ENTERED',
      resource: { values: [[ order.id, tashkentTime(order.date), order.name, order.phone, order.tgUser||'', items, order.total, order.mapLink||'', order.note||'', 'Ожидает подтверждения', '','','','' ]] }
    });
  } catch (e) { console.error('Sheet append error:', e.message); }
}

async function updateSheetStatus(orderId, statusLabel, colIndex) {
  const client = await getSheetsClient();
  if (!client || !colIndex) return;
  try {
    const res = await client.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${SHEET_NAME}!A:A` });
    const rowNum = (res.data.values || []).findIndex(r => r[0] === orderId) + 1;
    if (!rowNum) return;
    const col = String.fromCharCode(64 + colIndex);
    const now = tashkentTime(new Date().toISOString());
    await client.spreadsheets.values.batchUpdate({
      spreadsheetId: SHEET_ID,
      resource: { valueInputOption: 'USER_ENTERED', data: [
        { range: `${SHEET_NAME}!J${rowNum}`, values: [[statusLabel]] },
        { range: `${SHEET_NAME}!${col}${rowNum}`, values: [[now]] }
      ]}
    });
  } catch (e) { console.error('Sheet update error:', e.message); }
}

// ── BUILD STATUS KEYBOARD ──
function buildKeyboard(order) {
  const idx = STATUS_FLOW.indexOf(order.status);
  const next = STATUS_FLOW.slice(idx + 1);
  if (!next.length) return { inline_keyboard: [[{ text: '🎉 Заказ завершён', callback_data: 'done' }]] };
  return { inline_keyboard: [next.map(s => ({ text: `${STATUS_CONFIG[s].emoji} ${STATUS_CONFIG[s].label}`, callback_data: `st:${s}:${order.id}` }))] };
}

// ── BOT ──
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply('Добро пожаловать в CSWEAR UZ! 👋\nНажмите кнопку ниже, чтобы открыть магазин.', {
    reply_markup: { keyboard: [[{ text: '🛍 Открыть магазин', web_app: { url: SHOP_URL } }]], resize_keyboard: true }
  });
});

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (data === 'done') { await ctx.answerCbQuery(); return; }
  if (!data.startsWith('st:')) return;

  const parts = data.split(':');
  const newStatus = parts[1];
  const orderId = parts[2];
  const order = orders[orderId];

  if (!order) { await ctx.answerCbQuery('Заказ не найден'); return; }
  const currentIdx = STATUS_FLOW.indexOf(order.status);
  const newIdx = STATUS_FLOW.indexOf(newStatus);
  if (newIdx <= currentIdx) { await ctx.answerCbQuery('Статус уже установлен'); return; }

  const now = new Date().toISOString();
  order.status = newStatus;
  if (!order.timeline) order.timeline = [];
  order.timeline.push({ status: newStatus, label: STATUS_CONFIG[newStatus].label, time: now });
  save();

  await updateSheetStatus(orderId, STATUS_CONFIG[newStatus].label, STATUS_CONFIG[newStatus].sheetCol);

  try { await ctx.editMessageReplyMarkup(buildKeyboard(order)); } catch (e) {}
  await ctx.answerCbQuery(`${STATUS_CONFIG[newStatus].emoji} ${STATUS_CONFIG[newStatus].label}`);
});

// ── EXPRESS ──
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
app.use(cors());
app.use(express.json());

app.post('/order', upload.single('screenshot'), async (req, res) => {
  try {
    const order = JSON.parse(req.body.orderData);
    order.status = 'pending';
    order.date = new Date().toISOString();
    order.timeline = [{ status: 'pending', label: 'Заказ получен', time: order.date }];
    orders[order.id] = order;
    save();

    await appendToSheet(order);

    const items = order.items.map(i => `• ${i.name} [${i.size}] × ${i.qty} — ${Number(i.sum).toLocaleString('ru-RU')} сум`).join('\n');
    const loc = order.mapLink ? `📍 <a href="${order.mapLink}">Открыть на карте</a>` : '📍 —';
    const msg =
      `🆕 <b>НОВЫЙ ЗАКАЗ ${order.id}</b>\n\n` +
      `👤 <b>${order.name}</b>\n📞 ${order.phone}\n💬 ${order.tgUser || '—'}\n📝 ${order.note || '—'}\n\n` +
      `🧾 <b>Товары:</b>\n${items}\n\n` +
      `💰 <b>ИТОГО: ${Number(order.total).toLocaleString('ru-RU')} сум</b>\n${loc}\n\n` +
      `📦 Доставка: 7–14 дней в Ташкент`;

    const kb = { inline_keyboard: [[{ text: '✅ Подтвердить оплату', callback_data: `st:confirmed:${order.id}` }]] };
    let sent;
    if (req.file) {
      sent = await bot.telegram.sendPhoto(OWNER_CHAT_ID, { source: req.file.buffer }, { caption: msg, parse_mode: 'HTML', reply_markup: kb });
    } else {
      sent = await bot.telegram.sendMessage(OWNER_CHAT_ID, msg, { parse_mode: 'HTML', reply_markup: kb });
    }
    orders[order.id].messageId = sent.message_id;
    save();
    res.json({ ok: true, orderId: order.id });
  } catch (e) {
    console.error('Order error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/orders/:userId', (req, res) => {
  const userOrders = Object.values(orders)
    .filter(o => String(o.userId) === String(req.params.userId))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json(userOrders);
});

app.get('/', (req, res) => res.json({ status: 'CSWEAR UZ running ✅' }));

app.listen(PORT, () => console.log(`Server on port ${PORT}`));
bot.launch();
console.log('Bot is running...');
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
