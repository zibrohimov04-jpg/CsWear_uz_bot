const { Telegraf } = require('telegraf');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SHOP_URL = process.env.SHOP_URL;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const SHEETS_URL = process.env.SHEETS_URL;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !SHOP_URL || !OWNER_CHAT_ID) { console.error('Missing env vars'); process.exit(1); }

const STATUS_CONFIG = {
  pending:     { label: 'Заказ получен',       emoji: '📋' },
  confirmed:   { label: 'Оплата подтверждена', emoji: '✅' },
  shipped:     { label: 'Отправлен',           emoji: '📦' },
  in_tashkent: { label: 'В Ташкенте',          emoji: '🏙' },
  delivered:   { label: 'Доставлен',           emoji: '🎉' }
};
const STATUS_FLOW = ['pending', 'confirmed', 'shipped', 'in_tashkent', 'delivered'];

const PROMO_CODES = {
  "CSWEAR10": { discount: 10, type: "percent" },
  "FIRST15":  { discount: 15, type: "percent" },
  "VIP20":    { discount: 20, type: "percent" }
};

// ── DB ──
const DB_FILE = './db.json';
let db = { orders: {}, customers: {} };
try {
  if (fs.existsSync(DB_FILE)) {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    db = JSON.parse(raw);
    if (!db.orders) db.orders = {};
    if (!db.customers) db.customers = {};
  }
} catch (e) { console.log('Fresh db'); }

function save() {
  try { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }
  catch (e) { console.error('Save error', e); }
}

async function postToSheet(data) {
  if (!SHEETS_URL) return;
  try {
    const res = await fetch(SHEETS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      redirect: 'follow'
    });
    const json = await res.json();
    if (!json.ok) console.error('Sheet error:', json.error);
    else console.log('Sheet updated OK');
  } catch (e) { console.error('Sheet error:', e.message); }
}

function tashkentTime(iso) {
  return new Date(iso || Date.now()).toLocaleString('ru-RU', { timeZone: 'Asia/Tashkent' });
}

function buildKeyboard(order) {
  const idx = STATUS_FLOW.indexOf(order.status);
  const next = STATUS_FLOW.slice(idx + 1);
  if (!next.length) return { inline_keyboard: [[{ text: '🎉 Заказ завершён', callback_data: 'done' }]] };
  return { inline_keyboard: [next.map(s => ({ text: `${STATUS_CONFIG[s].emoji} ${STATUS_CONFIG[s].label}`, callback_data: `st:${s}:${order.id}` }))] };
}

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  const userId = String(ctx.from.id);
  if (!db.customers[userId]) db.customers[userId] = {};
  db.customers[userId].chatId = ctx.chat.id;
  db.customers[userId].username = ctx.from.username || null;
  db.customers[userId].firstName = ctx.from.first_name || null;
  save();

  ctx.reply(
    'Добро пожаловать в CSWEAR UZ! 👋\n\nНажмите кнопку «Открыть магазин» внизу экрана, чтобы просмотреть коллекцию.',
    { reply_markup: { remove_keyboard: true } }
  );
});

bot.command('broadcast', async (ctx) => {
  if (String(ctx.from.id) !== String(OWNER_CHAT_ID)) return;
  const text = ctx.message.text.replace('/broadcast', '').trim();
  if (!text) { ctx.reply('Используйте: /broadcast ваше сообщение'); return; }
  const customers = Object.values(db.customers).filter(c => c.chatId);
  let sent = 0, failed = 0;
  for (const customer of customers) {
    try {
      await bot.telegram.sendMessage(customer.chatId, `📢 *Сообщение от CSWEAR UZ*\n\n${text}`, { parse_mode: 'Markdown' });
      sent++;
    } catch (e) { failed++; }
  }
  ctx.reply(`✅ Отправлено: ${sent}\n❌ Ошибок: ${failed}`);
});

bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (data === 'done') { await ctx.answerCbQuery(); return; }

  if (data.startsWith('review:')) {
    const parts = data.split(':');
    const orderId = parts[1];
    const rating = Number(parts[2]);
    const order = db.orders[orderId];
    if (!order) { await ctx.answerCbQuery(); return; }
    order.review = { rating, time: new Date().toISOString() };
    order.awaitingReviewComment = true;
    save();
    const stars = '⭐'.repeat(rating) + '☆'.repeat(5 - rating);
    await ctx.editMessageText(
      `Спасибо за оценку! ${stars}\n\nЕсли хотите оставить комментарий — просто напишите его в чат.`
    );
    await bot.telegram.sendMessage(OWNER_CHAT_ID,
      `⭐ *Новый отзыв — заказ ${orderId}*\nОценка: ${stars}\nКлиент: ${order.customerName || '—'}`,
      { parse_mode: 'Markdown' }
    );
    await ctx.answerCbQuery('Спасибо! 🙏');
    return;
  }

  if (!data.startsWith('st:')) return;
  const parts = data.split(':');
  const newStatus = parts[1];
  const orderId = parts[2];
  const order = db.orders[orderId];
  if (!order) { await ctx.answerCbQuery('Заказ не найден'); return; }
  const currentIdx = STATUS_FLOW.indexOf(order.status);
  const newIdx = STATUS_FLOW.indexOf(newStatus);
  if (newIdx <= currentIdx) { await ctx.answerCbQuery('Уже обновлено'); return; }

  const now = new Date().toISOString();
  order.status = newStatus;
  if (!order.timeline) order.timeline = [];
  order.timeline.push({ status: newStatus, label: STATUS_CONFIG[newStatus].label, time: now });
  save();

  await postToSheet({
    type: 'status_update', id: orderId, status: newStatus,
    statusLabel: STATUS_CONFIG[newStatus].label, time: tashkentTime(now)
  });

  if (newStatus === 'delivered' && order.userId) {
    const customer = db.customers[order.userId];
    if (customer?.chatId) {
      try {
        await bot.telegram.sendMessage(customer.chatId,
          `🎉 Ваш заказ *${orderId}* доставлен! Спасибо за покупку в CSWEAR UZ!\n\nПожалуйста, оцените ваш опыт:`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [[
                { text: '⭐', callback_data: `review:${orderId}:1` },
                { text: '⭐⭐', callback_data: `review:${orderId}:2` },
                { text: '⭐⭐⭐', callback_data: `review:${orderId}:3` },
                { text: '⭐⭐⭐⭐', callback_data: `review:${orderId}:4` },
                { text: '⭐⭐⭐⭐⭐', callback_data: `review:${orderId}:5` }
              ]]
            }
          }
        );
      } catch (e) { console.error('Review msg error:', e.message); }
    }
  }

  try { await ctx.editMessageReplyMarkup(buildKeyboard(order)); } catch (e) {}
  await ctx.answerCbQuery(`${STATUS_CONFIG[newStatus].emoji} ${STATUS_CONFIG[newStatus].label}`);
});

bot.on('message', async (ctx) => {
  if (ctx.message.web_app_data) return;
  const userId = String(ctx.from.id);
  // Save customer on any message
  if (!db.customers[userId]) db.customers[userId] = {};
  db.customers[userId].chatId = ctx.chat.id;
  db.customers[userId].username = ctx.from.username || null;
  save();

  const pendingReview = Object.values(db.orders).find(
    o => o.userId === userId && o.awaitingReviewComment && o.review && !o.review.comment
  );
  if (pendingReview && ctx.message.text) {
    pendingReview.review.comment = ctx.message.text;
    pendingReview.awaitingReviewComment = false;
    save();
    await ctx.reply('Спасибо за ваш отзыв! 🙏');
    await bot.telegram.sendMessage(OWNER_CHAT_ID,
      `💬 *Комментарий к отзыву ${pendingReview.id}*\n\n"${ctx.message.text}"`,
      { parse_mode: 'Markdown' }
    );
  }
});

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
app.use(cors());
app.use(express.json());

app.post('/promo', (req, res) => {
  const code = (req.body.code || '').toUpperCase().trim();
  const promo = PROMO_CODES[code];
  if (promo) res.json({ ok: true, discount: promo.discount, type: promo.type });
  else res.json({ ok: false, error: 'Промокод недействителен' });
});

app.post('/order', upload.single('screenshot'), async (req, res) => {
  try {
    const order = JSON.parse(req.body.orderData);
    order.status = 'pending';
    order.date = new Date().toISOString();
    order.timeline = [{ status: 'pending', label: 'Заказ получен', time: order.date }];

    const customer = db.customers[order.userId];
    const tgUsername = order.tgUser ||
      (customer?.username ? '@' + customer.username : null) ||
      customer?.firstName || '—';
    order.customerName = tgUsername;

    if (customer) {
      db.customers[order.userId].lastOrderId = order.id;
    }

    db.orders[order.id] = order;
    save();

    await postToSheet({
      type: 'new_order', id: order.id, date: tashkentTime(order.date),
      name: order.name, phone: order.phone, tgUser: tgUsername,
      items: order.items, total: order.total,
      mapLink: order.mapLink || '', note: order.note || ''
    });

    const items = order.items.map(i =>
      `• ${i.name} [${i.size}] × ${i.qty} — ${Number(i.sum).toLocaleString('ru-RU')} сум`
    ).join('\n');
    const loc = order.mapLink ? `📍 <a href="${order.mapLink}">Открыть на карте</a>` : '📍 —';
    const promoLine = order.promoCode ? `🏷 Промокод: ${order.promoCode} (-${order.discount}%)\n` : '';

    const msg =
      `🆕 <b>НОВЫЙ ЗАКАЗ ${order.id}</b>\n\n` +
      `👤 <b>${order.name}</b>\n📞 ${order.phone}\n💬 ${tgUsername}\n📝 ${order.note || '—'}\n\n` +
      `🧾 <b>Товары:</b>\n${items}\n\n` +
      `${promoLine}💰 <b>ИТОГО: ${Number(order.total).toLocaleString('ru-RU')} сум</b>\n${loc}\n\n` +
      `📦 Доставка: 7–14 дней в Ташкент`;

    const kb = { inline_keyboard: [[{ text: '✅ Подтвердить оплату', callback_data: `st:confirmed:${order.id}` }]] };

    let sent;
    if (req.file) {
      sent = await bot.telegram.sendPhoto(OWNER_CHAT_ID, { source: req.file.buffer }, { caption: msg, parse_mode: 'HTML', reply_markup: kb });
    } else {
      sent = await bot.telegram.sendMessage(OWNER_CHAT_ID, msg, { parse_mode: 'HTML', reply_markup: kb });
    }

    db.orders[order.id].messageId = sent.message_id;
    save();
    res.json({ ok: true, orderId: order.id });
  } catch (e) {
    console.error('Order error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/orders/:userId', (req, res) => {
  const userOrders = Object.values(db.orders)
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
