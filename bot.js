const { Telegraf } = require('telegraf');
const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SHOP_URL = process.env.SHOP_URL;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !SHOP_URL || !OWNER_CHAT_ID) {
  console.error('Missing env vars: BOT_TOKEN, SHOP_URL, OWNER_CHAT_ID');
  process.exit(1);
}

// ── ORDER STORE ──
const ORDERS_FILE = './orders.json';
let orders = {};
try {
  if (fs.existsSync(ORDERS_FILE)) orders = JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf8'));
} catch (e) { console.log('Starting fresh order store'); }

function save() {
  try { fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2)); }
  catch (e) { console.error('Save failed', e); }
}

// ── BOT ──
const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply('Добро пожаловать в CSWEAR UZ! 👋\nНажмите кнопку ниже, чтобы открыть магазин.', {
    reply_markup: {
      keyboard: [[{ text: '🛍 Открыть магазин', web_app: { url: SHOP_URL } }]],
      resize_keyboard: true
    }
  });
});

// Confirm button handler
bot.on('callback_query', async (ctx) => {
  const data = ctx.callbackQuery.data;
  if (!data.startsWith('confirm_')) return;

  const orderId = data.replace('confirm_', '');
  const order = orders[orderId];

  if (!order) { await ctx.answerCbQuery('Заказ не найден'); return; }
  if (order.status === 'confirmed') { await ctx.answerCbQuery('Уже подтверждён ✅'); return; }

  order.status = 'confirmed';
  order.confirmedAt = new Date().toISOString();
  save();

  try {
    await ctx.editMessageReplyMarkup({
      inline_keyboard: [[{ text: '✅ Оплата подтверждена', callback_data: 'done' }]]
    });
  } catch (e) {}

  await ctx.answerCbQuery('✅ Заказ подтверждён!');
});

// ── EXPRESS SERVER ──
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

// POST /order — receive order + screenshot from frontend
app.post('/order', upload.single('screenshot'), async (req, res) => {
  try {
    const order = JSON.parse(req.body.orderData);
    order.status = 'pending';
    order.date = new Date().toISOString();
    orders[order.id] = order;
    save();

    const itemsText = order.items
      .map(i => `• ${i.name} [${i.size}] × ${i.qty} — ${Number(i.sum).toLocaleString('ru-RU')} сум`)
      .join('\n');

    const locationLine = order.mapLink
      ? `📍 <a href="${order.mapLink}">Открыть на карте</a>`
      : '📍 Локация не указана';

    const msg =
      `🆕 <b>НОВЫЙ ЗАКАЗ ${order.id}</b>\n\n` +
      `👤 <b>${order.name}</b>\n` +
      `📞 ${order.phone}\n` +
      `💬 ${order.tgUser || '—'}\n` +
      `📝 ${order.note || '—'}\n\n` +
      `🧾 <b>Товары:</b>\n${itemsText}\n\n` +
      `💰 <b>ИТОГО: ${Number(order.total).toLocaleString('ru-RU')} сум</b>\n\n` +
      `${locationLine}`;

    const confirmMarkup = {
      inline_keyboard: [[{ text: '✅ Подтвердить оплату', callback_data: `confirm_${order.id}` }]]
    };

    let sent;
    if (req.file) {
      sent = await bot.telegram.sendPhoto(
        OWNER_CHAT_ID,
        { source: req.file.buffer },
        { caption: msg, parse_mode: 'HTML', reply_markup: confirmMarkup }
      );
    } else {
      sent = await bot.telegram.sendMessage(OWNER_CHAT_ID, msg, {
        parse_mode: 'HTML', reply_markup: confirmMarkup
      });
    }

    orders[order.id].messageId = sent.message_id;
    save();

    res.json({ ok: true, orderId: order.id });
  } catch (e) {
    console.error('Order error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// GET /orders/:userId — frontend polls this for status updates
app.get('/orders/:userId', (req, res) => {
  const userOrders = Object.values(orders)
    .filter(o => String(o.userId) === String(req.params.userId))
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  res.json(userOrders);
});

// Health check
app.get('/', (req, res) => res.json({ status: 'CSWEAR UZ bot running' }));

app.listen(PORT, () => console.log(`Server on port ${PORT}`));
bot.launch();
console.log('Bot is running...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
