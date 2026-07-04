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


async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !SHEET_ID) return null;
  try {
    // Use separate env vars to avoid Railway JSON encoding issues
    let privateKey = process.env.GOOGLE_PRIVATE_KEY;
    // Normalize newlines
    privateKey = privateKey.replace(/\\n/g, '\n');
    const creds = {
      type: 'service_account',
      client_email: process.env.GOOGLE_CLIENT_EMAIL,
      private_key: privateKey,
      private_key_id: process.env.GOOGLE_PRIVATE_KEY_ID || '',
      token_uri: 'https://oauth2.googleapis.com/token'
    };

    const auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
    sheetsClient = google.sheets({ version: 'v4', auth });
    await ensureHeader();
    return sheetsClient;
  } catch (e) { console.error('Sheets init error:', e.message); return null; }
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

  await postToSheet({
    type: 'status_update',
    id: orderId,
    status: newStatus,
    statusLabel: STATUS_CONFIG[newStatus].label,
    time: new Date().toLocaleString('ru-RU', {timeZone:'Asia/Tashkent'})
  });

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

    await postToSheet({
      type: 'new_order',
      id: order.id,
      date: new Date(order.date).toLocaleString('ru-RU', {timeZone:'Asia/Tashkent'}),
      name: order.name,
      phone: order.phone,
      tgUser: order.tgUser||'',
      items: order.items,
      total: order.total,
      mapLink: order.mapLink||'',
      note: order.note||''
    });

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
