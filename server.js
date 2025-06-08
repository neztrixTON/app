// server.js
// ===========================
// Express-сервер с интеграцией Telegram Bot API
// 1) Хранит участников (participants) и метаданные (meta) по каждому чату
// 2) При отправке сообщения уведомляет всех, кроме отправителя
// 3) В GET /api/messages возвращает список участников и флаг isAdmin
// ===========================

const express    = require('express');
const fs         = require('fs');
const path       = require('path');
const bodyParser = require('body-parser');
const cors       = require('cors');
const multer     = require('multer');
const fetch      = require('node-fetch');  // npm install node-fetch@2
require('dotenv').config();

const app        = express();
const PORT       = parseInt(process.env.PORT) || 3000;
const DB_PATH    = path.join(__dirname, 'chat-db.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// Telegram Bot API
const BOT_TOKEN = process.env.BOT_TOKEN;
const TG_API    = `https://api.telegram.org/bot${BOT_TOKEN}`;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/files', express.static(UPLOAD_DIR));

// Multer для загрузки файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage });

// «БД» в JSON
let chatDB = { chats: {}, users: {}, admins: [] };
if (fs.existsSync(DB_PATH)) {
  try {
    chatDB = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    console.error('Ошибка чтения DB, создаём новую:', e);
    saveDB();
  }
} else {
  saveDB();
}

function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(chatDB, null, 2));
}

// Отметить пользователя онлайн
function markOnline(userId) {
  chatDB.users[userId] = Date.now();
  saveDB();
}
function isOnline(userId) {
  const last = chatDB.users[userId];
  return last && (Date.now() - last) < 30000;
}

// Уведомление через Telegram Bot API
async function notifyUser(to, text, chatId) {
  await fetch(`${TG_API}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: to,
      text,
      reply_markup: {
        inline_keyboard: [[
          { text: 'Открыть чат', web_app: { url: `${process.env.WEBAPP_URL}/chat.html?chatId=${chatId}` } }
        ]]
      }
    })
  });
}

// --- API ---

// GET /api/chats?userId=...
app.get('/api/chats', (req, res) => {
  const userId = String(req.query.userId || '');
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  markOnline(userId);

  const isAdmin = chatDB.admins.includes(userId);
  const result = [];

  for (const [chatId, chat] of Object.entries(chatDB.chats)) {
    const parts = chat.participants.map(p => p.id);
    if (!parts.includes(userId)) continue;

    const other = chat.participants.find(p => p.id !== userId) || {};
    const unread = chat.messages.filter(m => m.to === userId && !m.read).length;
    const lastMsg = chat.messages.slice(-1)[0] || {};

    result.push({
      chatId,
      title: `Чат по заявке #${chat.meta.requestId}`,
      online: parts.filter(id => id !== userId).some(isOnline),
      unreadCount: unread,
      lastMessage: lastMsg.text || '[файл]',
      meta: chat.meta,
      isAdmin
    });
  }

  res.json(result);
});

// POST /api/create-chat
app.post('/api/create-chat', (req, res) => {
  const { from, to, meta = {}, role = 'manager' } = req.body;
  if (!from || !to) return res.status(400).json({ error: 'Invalid participants' });

  const chatId = String(to);
  if (!chatDB.chats[chatId]) {
    chatDB.chats[chatId] = {
      participants: [
        { id: String(from), role },
        { id: String(to),   role: 'client' }
      ],
      messages: [],
      meta
    };
    saveDB();
  }

  if (role !== 'client' && !chatDB.admins.includes(String(from))) {
    chatDB.admins.push(String(from));
    saveDB();
  }

  res.json({ chatId });
});

// POST /api/add-to-chat
app.post('/api/add-to-chat', (req, res) => {
  const { chatId, userId, role } = req.body;
  const chat = chatDB.chats[chatId];
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  if (!chat.participants.find(p => p.id === String(userId))) {
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

// POST /api/messages/send
app.post('/api/messages/send', async (req, res) => {
  const { chatId, from, to, text, replyTo } = req.body;
  const chat = chatDB.chats[chatId];
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  const msg = {
    id: Date.now() + '_' + Math.random().toString(36).slice(2,6),
    from: String(from),
    to: String(to),
    text: text || null,
    file: null,
    ts: Date.now(),
    read: false,
    replyTo: replyTo || null
  };

  chat.messages.push(msg);
  saveDB();

  // уведомляем всех, кроме отправителя
  for (const p of chat.participants) {
    if (p.id === String(from)) continue;
    const roleName = p.role.charAt(0).toUpperCase() + p.role.slice(1);
    await notifyUser(
      p.id,
      `📩 Новое сообщение от ${roleName}:\n\n${text}`,
      chatId
    );
  }

  res.json({ success: true, message: msg });
});

// POST /api/messages/send-file
app.post('/api/messages/send-file', upload.single('file'), async (req, res) => {
  const { chatId, from, to, replyTo, text } = req.body;
  const chat = chatDB.chats[chatId];
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  const fileUrl = `/files/${req.file.filename}`;
  const msg = {
    id: Date.now() + '_' + Math.random().toString(36).slice(2,6),
    from: String(from),
    to: String(to),
    text: text || null,
    file: fileUrl,
    ts: Date.now(),
    read: false,
    replyTo: replyTo || null
  };

  chat.messages.push(msg);
  saveDB();

  for (const p of chat.participants) {
    if (p.id === String(from)) continue;
    const roleName = p.role.charAt(0).toUpperCase() + p.role.slice(1);
    await notifyUser(
      p.id,
      `📩 Новое сообщение от ${roleName}:\n\n${text || '[файл]'}`,
      chatId
    );
  }

  res.json({ success: true, message: msg });
});

// GET /api/messages
app.get('/api/messages', (req, res) => {
  const chatId = String(req.query.chatId || '');
  const userId = String(req.query.userId || '');
  if (!chatId || !userId) return res.status(400).json({ error: 'Missing parameters' });

  const chat = chatDB.chats[chatId];
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  markOnline(userId);
  chat.messages.forEach(m => { if (m.to === userId) m.read = true; });
  saveDB();

  // Формируем meta с участниками и флагом isAdmin
  const meta = {
    ...chat.meta,
    participants: chat.participants,
    isAdmin: chatDB.admins.includes(userId)
  };

  res.json({ messages: chat.messages, meta });
});

// GET /api/status
app.get('/api/status', (req, res) => {
  const userId = String(req.query.userId || '');
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  res.json({ online: isOnline(userId) });
});

// catch-all → public/index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
