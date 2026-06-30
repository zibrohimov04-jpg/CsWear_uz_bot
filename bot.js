// bot.js
// Telegram bot for the clothes shop.
// Receives orders from the Mini App (web_app_data) and forwards them to OWNER_CHAT_ID.

const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;       // from BotFather
const SHOP_URL = process.env.SHOP_URL;         // your hosted frontend URL (https://...)
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID; // your own Telegram numeric chat id

if (!BOT_TOKEN || !SHOP_URL || !OWNER_CHAT_ID) {
  console.error('Missing env vars. Need BOT_TOKEN, SHOP_URL, OWNER_CHAT_ID.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

// /start — greet the customer and show button that opens the shop
bot.start((ctx) => {
  ctx.reply(
    'Добро пожаловать! 👋\nНажмите кнопку ниже, чтобы открыть каталог.',
    {
      reply_markup: {
        inline_keyboard: [[{ text: '🛍 Открыть магазин', web_app: { url: SHOP_URL } }]]
      }
    }
  );
});

// Handle data sent from the Mini App when customer submits an order
bot.on('message', async (ctx) => {
  const data = ctx.message.web_app_data?.data;
  if (!data) return;

  let order;
  try {
    order = JSON.parse(data);
  } catch (e) {
    console.error('Bad order payload', e);
    return;
  }

  const itemsText = order.items
    .map((i) => `• ${i.name} × ${i.qty} — ${i.sum.toLocaleString('ru-RU')} сум`)
    .join('\n');

  const customerUsername = ctx.from.username ? '@' + ctx.from.username : '(нет username)';

  const messageToOwner =
    `🆕 НОВЫЙ ЗАКАЗ\n\n` +
    `Имя: ${order.name}\n` +
    `Телефон: ${order.phone}\n` +
    `Адрес: ${order.addr || '—'}\n` +
    `Комментарий: ${order.note || '—'}\n` +
    `Telegram: ${customerUsername}\n\n` +
    `Товары:\n${itemsText}\n\n` +
    `ИТОГО: ${order.total.toLocaleString('ru-RU')} сум`;

  // Send the order to you (the shop owner)
  await bot.telegram.sendMessage(OWNER_CHAT_ID, messageToOwner);

  // Confirm to the customer
  await ctx.reply(
    'Спасибо! Ваш заказ принят ✅\nМы свяжемся с вами в ближайшее время для подтверждения оплаты и доставки.'
  );
});

bot.launch();
console.log('Bot is running...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
