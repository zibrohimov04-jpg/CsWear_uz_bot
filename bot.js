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
  rejected:    { label: 'Оплата отклонена',    emoji: '❌' },
  confirmed:   { label: 'Оплата подтверждена', emoji: '✅' },
  shipped:     { label: 'Отправлен',           emoji: '📦' },
  in_tashkent: { label: 'В Ташкенте',          emoji: '🏙' },
  delivered:   { label: 'Доставлен',           emoji: '🎉' },
  cancelled:   { label: 'Отменён',              emoji: '🚫' }
};
const STATUS_FLOW = ['pending', 'confirmed', 'shipped', 'in_tashkent', 'delivered'];

const PROMO_CODES = {
  "CSWEAR15": { discount: 15, type: "percent" }
};

// ── DB ──
const DB_FILE = './db.json';
let db = { orders: {}, customers: {}, promoUsage: {} };
try {
  if (fs.existsSync(DB_FILE)) {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    db = JSON.parse(raw);
    if (!db.orders) db.orders = {};
    if (!db.customers) db.customers = {};
    if (!db.promoUsage) db.promoUsage = {};
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
  saveCustomer(ctx);
  const userId = String(ctx.from.id);

  ctx.reply(
    'Добро пожаловать в CSWEAR UZ! 👋\n\nНажмите кнопку «Открыть магазин» внизу экрана, чтобы просмотреть коллекцию.',
    { reply_markup: { remove_keyboard: true } }
  );
});

bot.command('promostats', async (ctx) => {
  if (String(ctx.from.id) !== String(OWNER_CHAT_ID)) return;

  const usages = Object.values(db.promoUsage);
  if (!usages.length) {
    ctx.reply('📊 Промокод CSWEAR15 ещё никто не использовал.');
    return;
  }

  const totalUses = usages.length;
  const totalDiscount = usages.reduce((s, u) => s + (u.discountAmount || 0), 0);
  const totalRevenue = usages.reduce((s, u) => s + (u.finalTotal || 0), 0);

  const list = usages.slice(-10).reverse().map(u =>
    `• ${u.customerName} (${u.tgUser}) — ${Number(u.finalTotal).toLocaleString('ru-RU')} сум — ${u.orderId}`
  ).join('\n');

  const msg =
    `📊 <b>Статистика промокода CSWEAR15</b>

` +
    `👥 Использований: <b>${totalUses}</b>
` +
    `💸 Суммарная скидка: <b>${totalDiscount.toLocaleString('ru-RU')} сум</b>
` +
    `💰 Выручка с промо: <b>${totalRevenue.toLocaleString('ru-RU')} сум</b>

` +
    `📋 <b>Последние ${Math.min(10, totalUses)} использований:</b>
${list}`;

  ctx.reply(msg, { parse_mode: 'HTML' });
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

  // Cancellation approve/reject
  if (data.startsWith('cancel_approve:') || data.startsWith('cancel_reject:')) {
    const isApprove = data.startsWith('cancel_approve:');
    const orderId = data.replace('cancel_approve:', '').replace('cancel_reject:', '');
    const order = db.orders[orderId];
    if (!order) { await ctx.answerCbQuery('Заказ не найден'); return; }

    if (isApprove) {
      order.status = 'cancelled';
      if (!order.timeline) order.timeline = [];
      order.timeline.push({ status: 'cancelled', label: 'Отменён', time: new Date().toISOString() });
      save();
      // Notify customer
      const customer = db.customers[order.userId];
      if (customer?.chatId) {
        try {
          await bot.telegram.sendMessage(customer.chatId,
            `✅ Ваш запрос на отмену заказа *${orderId}* одобрен.\n\nЕсли вы уже оплатили — свяжитесь с нами для возврата средств.`,
            { parse_mode: 'Markdown' }
          );
        } catch(e) {}
      }
      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '✅ Отмена одобрена', callback_data: 'done' }]] }); } catch(e) {}
      await ctx.answerCbQuery('✅ Заказ отменён');
    } else {
      const customer = db.customers[order.userId];
      if (customer?.chatId) {
        try {
          await bot.telegram.sendMessage(customer.chatId,
            `❌ Запрос на отмену заказа *${orderId}* отклонён.\n\nЕсли у вас есть вопросы — напишите нам напрямую.`,
            { parse_mode: 'Markdown' }
          );
        } catch(e) {}
      }
      try { await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '❌ Отмена отклонена', callback_data: 'done' }]] }); } catch(e) {}
      await ctx.answerCbQuery('❌ Отмена отклонена');
    }
    return;
  }

  if (data.startsWith('reject:')) {
    const orderId = data.replace('reject:', '');
    const order = db.orders[orderId];
    if (!order) { await ctx.answerCbQuery('Заказ не найден'); return; }
    if (order.status !== 'pending') { await ctx.answerCbQuery('Заказ уже обработан'); return; }

    // Update order status to rejected
    order.status = 'rejected';
    if (!order.timeline) order.timeline = [];
    order.timeline.push({ status: 'rejected', label: 'Оплата отклонена', time: new Date().toISOString() });
    save();

    // Update sheets
    await postToSheet({
      type: 'status_update', id: orderId, status: 'rejected',
      statusLabel: 'Оплата отклонена', time: tashkentTime(new Date().toISOString())
    });

    // Notify customer
    const customer = db.customers[order.userId];
    if (customer?.chatId) {
      try {
        await bot.telegram.sendMessage(
          customer.chatId,
          `❌ *Оплата по заказу ${orderId} не принята*

Прикреплённый скриншот не является подтверждением оплаты из Click или Payme.

*Что делать:*
1. Оплатите заказ через Click или Payme
2. Сделайте скриншот подтверждения оплаты прямо в приложении
3. Откройте магазин заново и оформите новый заказ с правильным скриншотом

Если у вас есть вопросы — напишите нам напрямую.`,
          { parse_mode: 'Markdown' }
        );
      } catch (e) { console.error('Reject notify error:', e.message); }
    }

    // Edit Telegram message
    try {
      await ctx.editMessageReplyMarkup({
        inline_keyboard: [[{ text: '❌ Оплата отклонена', callback_data: 'done' }]]
      });
    } catch(e) {}

    await ctx.answerCbQuery('❌ Оплата отклонена, клиент уведомлён');
    return;
  }

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

  // Notify customer on every status change
  const customer = db.customers[order.userId];
  if (customer?.chatId) {
    try {
      const statusMessages = {
        confirmed:   `✅ Ваш заказ *${orderId}* подтверждён!\n\nОплата принята. Мы начинаем обработку вашего заказа. Следите за статусом в разделе «Заказы» в магазине.`,
        shipped:     `📦 Ваш заказ *${orderId}* отправлен!\n\nПосылка уже в пути. Ожидайте доставки в течение 7–14 дней.`,
        in_tashkent: `🏙 Ваш заказ *${orderId}* прибыл в Ташкент!\n\nМы свяжемся с вами для согласования доставки.`,
        delivered:   null // handled separately with review
      };

      if (newStatus === 'delivered') {
        await bot.telegram.sendMessage(customer.chatId,
          `🎉 Ваш заказ *${orderId}* доставлен!\n\nСпасибо за покупку в CSWEAR UZ! Надеемся, вам понравится 🔥\n\nПожалуйста, оцените ваш опыт:`,
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                [{ text: '⭐ 1', callback_data: `review:${orderId}:1` }],
                [{ text: '⭐⭐ 2', callback_data: `review:${orderId}:2` }],
                [{ text: '⭐⭐⭐ 3', callback_data: `review:${orderId}:3` }],
                [{ text: '⭐⭐⭐⭐ 4', callback_data: `review:${orderId}:4` }],
                [{ text: '⭐⭐⭐⭐⭐ 5', callback_data: `review:${orderId}:5` }]
              ]
            }
          }
        );
      } else if (statusMessages[newStatus]) {
        await bot.telegram.sendMessage(customer.chatId, statusMessages[newStatus], { parse_mode: 'Markdown' });
      }
    } catch (e) { console.error('Status notify error:', e.message); }
  }

  try { await ctx.editMessageReplyMarkup(buildKeyboard(order)); } catch (e) {}
  await ctx.answerCbQuery(`${STATUS_CONFIG[newStatus].emoji} ${STATUS_CONFIG[newStatus].label}`);
});

function saveCustomer(ctx) {
  try {
    const userId = String(ctx.from.id);
    if (!db.customers[userId]) db.customers[userId] = {};
    db.customers[userId].chatId = ctx.chat.id;
    if (ctx.from.username) db.customers[userId].username = ctx.from.username;
    if (ctx.from.first_name) db.customers[userId].firstName = ctx.from.first_name;
    save();
  } catch(e) {}
}

bot.on('message', async (ctx) => {
  if (ctx.message.web_app_data) return;
  saveCustomer(ctx);

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
  const userId = String(req.body.userId || '');
  const promo = PROMO_CODES[code];

  if (!promo) return res.json({ ok: false, error: 'Промокод недействителен' });

  const usageKey = code + '_' + userId;
  if (userId && db.promoUsage[usageKey]) {
    return res.json({ ok: false, error: 'Вы уже использовали этот промокод' });
  }

  // Lock immediately
  if (userId) {
    db.promoUsage[usageKey] = { code, userId, usedAt: new Date().toISOString(), confirmed: false };
    save();
  }

  res.json({ ok: true, discount: promo.discount, type: promo.type });
});

app.post('/order', upload.single('screenshot'), async (req, res) => {
  try {
    const order = JSON.parse(req.body.orderData);
    order.status = 'pending';
    order.date = new Date().toISOString();
    order.timeline = [{ status: 'pending', label: 'Заказ получен', time: order.date }];

    const customer = db.customers[order.userId] || {};
    // Try all sources for username
    const tgUsername =
      (order.tgUser && order.tgUser !== '—' ? order.tgUser : null) ||
      (customer.username ? '@' + customer.username : null) ||
      customer.firstName ||
      `tg:${order.userId}` ||
      '—';
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
      mapLink: order.mapLink || '', note: order.note || '',
      promoCode: order.promoCode || '', discount: order.discount || 0
    });

    // Confirm promo usage
    if (order.promoCode && order.userId) {
      const usageKey = `${order.promoCode}_${order.userId}`;
      db.promoUsage[usageKey] = {
        ...( db.promoUsage[usageKey] || {} ),
        code: order.promoCode,
        userId: order.userId,
        orderId: order.id,
        customerName: order.name,
        phone: order.phone,
        tgUser: tgUsername,
        originalTotal: Math.round(order.total / (1 - order.discount/100)),
        discountAmount: Math.round(order.total / (1 - order.discount/100)) - order.total,
        finalTotal: order.total,
        date: order.date,
        confirmed: true
      };
      save();

      // Log to sheets promo tab
      await postToSheet({
        type: 'promo_use',
        code: order.promoCode,
        orderId: order.id,
        date: tashkentTime(order.date),
        customerName: order.name,
        phone: order.phone,
        tgUser: tgUsername,
        originalTotal: Math.round(order.total / (1 - order.discount/100)),
        discountAmount: Math.round(order.total / (1 - order.discount/100)) - order.total,
        finalTotal: order.total
      });
    }

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

    const kb = { inline_keyboard: [
      [{ text: '✅ Подтвердить оплату', callback_data: `st:confirmed:${order.id}` }],
      [{ text: '❌ Отклонить оплату', callback_data: `reject:${order.id}` }]
    ]};

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

// Cancellation request
app.post('/cancel', async (req, res) => {
  try {
    const { orderId, userId, reason } = req.body;
    const order = db.orders[orderId];
    if (!order) return res.json({ ok: false, error: 'Заказ не найден' });
    if (String(order.userId) !== String(userId)) return res.json({ ok: false, error: 'Нет доступа' });
    if (order.status !== 'pending') return res.json({ ok: false, error: 'Заказ уже обработан и не может быть отменён' });

    // Notify owner with approve/reject buttons
    const customer = db.customers[userId];
    const tgUsername = customer?.username ? '@' + customer.username : order.customerName || '—';
    const items = order.items.map(i => `• ${i.name} [${i.size}] × ${i.qty}`).join('\n');

    const msg =
      `⚠️ <b>ЗАПРОС НА ОТМЕНУ ${orderId}</b>

` +
      `👤 ${order.name}
📞 ${order.phone}
💬 ${tgUsername}

` +
      `🧾 Товары:
${items}
💰 ${Number(order.total).toLocaleString('ru-RU')} сум

` +
      `❓ <b>Причина отмены:</b>
${reason}`;

    await bot.telegram.sendMessage(OWNER_CHAT_ID, msg, {
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: [[
        { text: '✅ Одобрить отмену', callback_data: `cancel_approve:${orderId}` },
        { text: '❌ Отклонить отмену', callback_data: `cancel_reject:${orderId}` }
      ]]}
    });

    res.json({ ok: true });
  } catch(e) {
    console.error('Cancel error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/', (req, res) => res.json({ status: 'CSWEAR UZ running ✅' }));

app.listen(PORT, () => console.log(`Server on port ${PORT}`));
bot.launch();
console.log('Bot is running...');

// ── DAILY SUMMARY at 08:00 Tashkent time (UTC+5 = 03:00 UTC) ──
function scheduleDailySummary() {
  const now = new Date();
  const tashkent = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Tashkent' }));
  const next = new Date(tashkent);
  next.setHours(8, 0, 0, 0);
  if (next <= tashkent) next.setDate(next.getDate() + 1);
  const msUntil = next - tashkent;
  setTimeout(async () => {
    await sendDailySummary();
    setInterval(sendDailySummary, 24 * 60 * 60 * 1000);
  }, msUntil);
  console.log(`Daily summary scheduled in ${Math.round(msUntil/60000)} minutes`);
}

async function sendDailySummary() {
  try {
    const now = new Date();
    const todayStr = now.toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent' });
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yStr = yesterday.toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent', day:'2-digit', month:'long' });

    const allOrders = Object.values(db.orders);
    const todayOrders = allOrders.filter(o => {
      const d = new Date(o.date).toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent' });
      return d === yesterday.toLocaleDateString('ru-RU', { timeZone: 'Asia/Tashkent' });
    });

    const total = todayOrders.filter(o => !['cancelled','rejected'].includes(o.status))
      .reduce((s,o) => s + Number(o.total), 0);
    const confirmed = todayOrders.filter(o => o.status === 'confirmed').length;
    const pending = todayOrders.filter(o => o.status === 'pending').length;
    const cancelled = todayOrders.filter(o => o.status === 'cancelled').length;
    const rejected = todayOrders.filter(o => o.status === 'rejected').length;

    const orderList = todayOrders.length > 0
      ? todayOrders.map(o => `• ${o.id} — ${o.name} — ${Number(o.total).toLocaleString('ru-RU')} сум [${STATUS_CONFIG[o.status]?.label || o.status}]`).join('\n')
      : 'Заказов не было';

    const msg =
      `📊 <b>Итоги за ${yStr}</b>

` +
      `📦 Всего заказов: <b>${todayOrders.length}</b>
` +
      `✅ Подтверждено: <b>${confirmed}</b>
` +
      `⏳ Ожидает: <b>${pending}</b>
` +
      `🚫 Отменено: <b>${cancelled}</b>
` +
      `❌ Отклонено: <b>${rejected}</b>
` +
      `💰 Выручка: <b>${total.toLocaleString('ru-RU')} сум</b>

` +
      `📋 <b>Список заказов:</b>
${orderList}`;

    await bot.telegram.sendMessage(OWNER_CHAT_ID, msg, { parse_mode: 'HTML' });
  } catch(e) {
    console.error('Daily summary error:', e.message);
  }
}

scheduleDailySummary();
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
