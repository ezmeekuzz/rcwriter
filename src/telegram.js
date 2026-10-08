// Sends RCWriter's alerts to your phone through your own Telegram bot.
const IMPORTANT = /fail|down|drop|fell|warning|problem|not indexed|repl(y|ied)|approval|security|expir|slower|enquir|lead|ssl|couldn't|could not|error/i;

function createTelegram({ store }) {
  const d = () => store.data;
  const cfg = () => d().telegram || (d().telegram = {});
  const token = () => store.decrypt(cfg().token);

  async function api(method, body) {
    const t = token();
    if (!t) throw new Error('Add your Telegram bot token first.');
    const res = await fetch(`https://api.telegram.org/bot${t}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(20000) });
    const j = await res.json().catch(() => ({}));
    if (!j.ok) throw new Error(`Telegram: ${j.description || res.status}`);
    return j.result;
  }

  async function setToken(t) {
    cfg().token = t ? store.encrypt(String(t).trim()) : null;
    if (!t) { delete cfg().chatId; delete cfg().bot; store.save(); return null; }
    const me = await api('getMe');
    cfg().bot = me.username;
    store.save();
    return me.username;
  }

  // The chat is found from the last message someone sent to the bot.
  async function findChat() {
    const ups = await api('getUpdates', { limit: 20 });
    const msg = [...ups].reverse().map((u) => u.message || u.channel_post).find(Boolean);
    if (!msg) throw new Error(`Open Telegram, send any message to @${cfg().bot || 'your bot'}, then try again.`);
    cfg().chatId = msg.chat.id;
    cfg().chatName = msg.chat.title || [msg.chat.first_name, msg.chat.last_name].filter(Boolean).join(' ') || msg.chat.username || 'your chat';
    store.save();
    await send('RCWriter is connected. Alerts will arrive here.');
    return cfg().chatName;
  }

  async function send(text) {
    if (!cfg().chatId) throw new Error('Find your chat first.');
    return api('sendMessage', { chat_id: cfg().chatId, text: String(text).slice(0, 4000), disable_web_page_preview: true });
  }

  // Called for every desktop notification.
  function alert(title, body) {
    const c = cfg();
    if (!c.enabled || !c.chatId || !c.token) return;
    if (c.level !== 'all' && !IMPORTANT.test(`${title} ${body}`)) return;
    send(`${title}\n${body || ''}`).catch(() => {});
  }

  function status() { const c = cfg(); return { hasToken: !!c.token, bot: c.bot || '', chatName: c.chatName || '', connected: !!(c.token && c.chatId), enabled: !!c.enabled, level: c.level || 'important' }; }

  return { setToken, findChat, send, alert, status };
}

module.exports = { createTelegram, IMPORTANT };
