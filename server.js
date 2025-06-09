// server.js
// =======================================
// Express-сервер + Telegram Bot API уведомления
// =======================================

const express    = require('express');
const fs         = require('fs');
const path       = require('path');
const bodyParser = require('body-parser');
const cors       = require('cors');
const multer     = require('multer');
const fetch      = require('node-fetch');  // npm install node-fetch@2
require('dotenv').config();

if (!process.env.BOT_TOKEN) {
  console.error('ERROR: BOT_TOKEN не задан');
  process.exit(1);
}
if (!process.env.WEBAPP_URL || !process.env.WEBAPP_URL.startsWith('https://')) {
  console.error('ERROR: WEBAPP_URL должен быть HTTPS URL');
  process.exit(1);
}

const app        = express();
const PORT       = parseInt(process.env.PORT) || 3000;
const DB_PATH    = path.join(__dirname, 'chat-db.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const BOT_TOKEN  = process.env.BOT_TOKEN;
const TG_API     = `https://api.telegram.org/bot${BOT_TOKEN}`;
const WEBAPP_URL = process.env.WEBAPP_URL;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/files', express.static(UPLOAD_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage });

// JSON‑«БД»
let chatDB = { chats: {}, users: {}, admins: [] };
if (fs.existsSync(DB_PATH)) {
  try { chatDB = JSON.parse(fs.readFileSync(DB_PATH,'utf8')); }
  catch(e){ console.error('DB parse error:', e); saveDB(); }
} else saveDB();
function saveDB(){ fs.writeFileSync(DB_PATH, JSON.stringify(chatDB, null, 2)); }

function markOnline(uid){ chatDB.users[uid] = Date.now(); saveDB(); }
function isOnline(uid){ return chatDB.users[uid] && (Date.now() - chatDB.users[uid] < 30000); }

// Универсальная отправка уведомления
async function notifyUser(to, chatId) {
  const chatUrl = `${WEBAPP_URL}/chat.html?chatId=${encodeURIComponent(chatId)}`;
  const text = '🔔 У вас новое непрочитанное сообщение';
  try {
    const res = await fetch(`${TG_API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json' },
      body: JSON.stringify({
        chat_id: to,
        text,
        reply_markup: {
          inline_keyboard: [[
            { text: 'Открыть чат', web_app: { url: chatUrl } }
          ]]
        }
      })
    });
    const json = await res.json();
    if (!json.ok) console.error('Telegram API error:', json);
  } catch (err) {
    console.error('notifyUser error:', err);
  }
}

// --- API ---

app.get('/api/chats', (req, res) => {
  const userId = String(req.query.userId || '');
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  markOnline(userId);

  const isAdmin = chatDB.admins.includes(userId);
  const out = [];

  for (const [chatId, chat] of Object.entries(chatDB.chats)) {
    const partIds = chat.participants.map(p => p.id);
    if (!partIds.includes(userId)) continue;

    const unread = chat.messages.filter(m => m.to === userId && !m.read).length;
    const last   = chat.messages.slice(-1)[0] || {};

    out.push({
      chatId,
      title:       `Чат по заявке #${chat.meta.requestId}`,
      online:      partIds.filter(id=>id!==userId).some(isOnline),
      unreadCount: unread,
      lastMessage: last.text || '[файл]',
      meta:        chat.meta,
      isAdmin
    });
  }

  res.json(out);
});

app.post('/api/create-chat', (req, res) => {
  const { from, to, meta = {}, role = 'manager' } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'Invalid payload' });

  const chatId = String(to);
  if (!chatDB.chats[chatId]) {
    chatDB.chats[chatId] = {
      participants: [
        { id: String(from), role },
        { id: String(to),   role: 'client' }
      ],
      messages: [],
      meta,
      notified: false
    };
    saveDB();
  }

  if (role !== 'client' && !chatDB.admins.includes(String(from))) {
    chatDB.admins.push(String(from));
    saveDB();
  }

  res.json({ chatId });
});

app.post('/api/add-to-chat', (req, res) => {
  const { chatId, userId, role } = req.body;
  const chat = chatDB.chats[chatId];
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  if (!chat.participants.find(p=>p.id===String(userId))) {
    chat.participants.push({ id: String(userId), role });
    saveDB();
  }
  if (['manager','master','consultant'].includes(role.toLowerCase())) {
    if (!chatDB.admins.includes(String(userId))) {
      chatDB.admins.push(String(userId));
      saveDB();
    }
  }
  res.json({ success: true });
});

app.post('/api/messages/send', async (req, res) => {
  const { chatId, from, to, text, replyTo } = req.body;
  const chat = chatDB.chats[chatId];
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  const msg = {
    id:      Date.now() + '_' + Math.random().toString(36).slice(2,6),
    from:    String(from),
    to:      String(to),
    text:    text || null,
    file:    null,
    ts:      Date.now(),
    read:    false,
    replyTo: replyTo || null
  };
  chat.messages.push(msg);
  chat.notified = false;
  saveDB();

  for (const p of chat.participants) {
    if (p.id === String(from)) continue;
    await notifyUser(p.id, chatId);
  }

  res.json({ success: true, message: msg });
});

app.post('/api/messages/send-file', upload.single('file'), async (req, res) => {
  const { chatId, from, to, replyTo, text } = req.body;
  const chat = chatDB.chats[chatId];
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  const fileUrl = `/files/${req.file.filename}`;
  const msg = {
    id:      Date.now() + '_' + Math.random().toString(36).slice(2,6),
    from:    String(from),
    to:      String(to),
    text:    text || null,
    file:    fileUrl,
    ts:      Date.now(),
    read:    false,
    replyTo: replyTo || null
  };
  chat.messages.push(msg);
  chat.notified = false;
  saveDB();

  for (const p of chat.participants) {
    if (p.id === String(from)) continue;
    await notifyUser(p.id, chatId);
  }

  res.json({ success: true, message: msg });
});

app.get('/api/messages', (req, res) => {
  const chatId = String(req.query.chatId || '');
  const userId = String(req.query.userId || '');
  if (!chatId || !userId) return res.status(400).json({ error: 'Missing parameters' });

  const chat = chatDB.chats[chatId];
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  markOnline(userId);

  chat.messages.forEach(m => { if (m.to === userId) m.read = true; });
  chat.notified = false;
  saveDB();

  const meta = {
    ...chat.meta,
    participants: chat.participants,
    isAdmin:      chatDB.admins.includes(userId)
  };
  res.json({ messages: chat.messages, meta });
});

app.get('/api/status', (req, res) => {
  const userId = String(req.query.userId || '');
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  res.json({ online: isOnline(userId) });
});

// Авто-напоминание о непрочитанных
setInterval(async () => {
  for (const [chatId, chat] of Object.entries(chatDB.chats)) {
    if (chat.notified) continue;
    for (const p of chat.participants) {
      const hasUnread = chat.messages.some(m => m.to === p.id && !m.read);
      if (hasUnread) {
        await notifyUser(p.id, chatId);
      }
    }
    chat.notified = true;
  }
  saveDB();
}, 60 * 1000);

// SPA catch-all
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
