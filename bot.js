const { Telegraf } = require('telegraf');

const BOT_TOKEN = process.env.BOT_TOKEN;
const SHOP_URL = process.env.SHOP_URL;
const OWNER_CHAT_ID = process.env.OWNER_CHAT_ID;

if (!BOT_TOKEN || !SHOP_URL || !OWNER_CHAT_ID) {
  console.error('Missing env vars.');
  process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

bot.start((ctx) => {
  ctx.reply('Добро пожаловать в CSWEAR UZ! 👋\nНажмите кнопку ниже, чтобы открыть магазин.', {
    reply_markup: {
      keyboard: [[{ text: '🛍 Открыть магазин', web_app: { url: SHOP_URL } }]],
      resize_keyboard: true
    }
  });
});

bot.on('message', async (ctx) => {
  const data = ctx.message.web_app_data?.data;
  if (!data) return;

  let order;
  try { order = JSON.parse(data); }
  catch (e) { console.error('Bad payload', e); return; }

  const customerUsername = ctx.from.username
    ? '@' + ctx.from.username
    : (order.tgUser || '(нет username)');

  const itemsText = order.items
    .map(i => `• ${i.name} [${i.size}] × ${i.qty} — ${Number(i.sum).toLocaleString('ru-RU')} сум`)
    .join('\n');

  const locationText = order.location
    ? `📍 Локация: ${order.mapLink}`
    : '📍 Адрес не указан';

  const msg =
    `🆕 НОВЫЙ ЗАКАЗ ${order.id}\n\n` +
    `👤 ${order.name}\n` +
    `📞 ${order.phone}\n` +
    `💬 ${customerUsername}\n` +
    `📝 ${order.note || '—'}\n\n` +
    `🧾 Товары:\n${itemsText}\n\n` +
    `💰 ИТОГО: ${Number(order.total).toLocaleString('ru-RU')} сум\n` +
    `${locationText}\n` +
    `✅ Клиент подтвердил оплату`;

  await bot.telegram.sendMessage(OWNER_CHAT_ID, msg);
  await ctx.reply(`✅ Заказ ${order.id} принят! Свяжемся с вами в ближайшее время. 🔥`);
});

bot.launch();
console.log('Bot is running...');
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
