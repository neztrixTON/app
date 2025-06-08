// server.js

// ------------------------------
// Расширенный Node.js/Express-сервер для mini-app-чата
// + интеграция с SQLite-базой бота (admins)
// + поддержка reply, комментариев к файлам
// + права: client, manager, master
// ------------------------------

const express    = require('express');
const fs         = require('fs');
const path       = require('path');
const bodyParser = require('body-parser');
const cors       = require('cors');
const multer     = require('multer');
const sqlite3    = require('sqlite3');
const { open }   = require('sqlite');

const app  = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// Пути
const DB_PATH     = path.join(__dirname, 'bot_database.db');
const CHAT_DB     = path.join(__dirname, 'chat-db.json');
const UPLOAD_DIR  = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// Инициализация chat-db.json
let chatDB = { chats: {}, users: {} };
if (fs.existsSync(CHAT_DB)) {
  try {
    chatDB = JSON.parse(fs.readFileSync(CHAT_DB, 'utf8'));
  } catch {
    chatDB = { chats: {}, users: {} };
    fs.writeFileSync(CHAT_DB, JSON.stringify(chatDB, null, 2));
  }
} else {
  fs.writeFileSync(CHAT_DB, JSON.stringify(chatDB, null, 2));
}
function saveDB() {
  fs.writeFileSync(CHAT_DB, JSON.stringify(chatDB, null, 2));
}

// Multer для файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, `${Date.now()}_${file.originalname}`)
});
const upload = multer({ storage });

// Middlewares
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/files', express.static(UPLOAD_DIR));

// SQLite из бота
let botDb;
(async () => {
  botDb = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });
})();

// Проверка online
function markOnline(userId) {
  chatDB.users[userId] = { lastSeen: Date.now() };
  saveDB();
}
function isOnline(userId) {
  const u = chatDB.users[userId];
  return u && (Date.now() - u.lastSeen < 30_000);
}

// Проверка роли admin из bot_database.db
async function isAdmin(userId) {
  const row = await botDb.get('SELECT * FROM admins WHERE user_id = ?', userId);
  return !!row;
}

// Генерация chatId по двум ID
function getChatId(a, b) {
  return [String(a), String(b)].sort().join('_');
}

// ------------------- API -------------------

// 1) GET /api/chats?userId=xxx
app.get('/api/chats', async (req, res) => {
  const userId = String(req.query.userId || '');
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  markOnline(userId);

  const result = [];
  for (const [chatId, chat] of Object.entries(chatDB.chats)) {
    if (chat.participants.includes(userId)) {
      const other = chat.participants.find(p => p !== userId);
      const unreadCount = chat.messages.filter(m => m.to === userId && !m.read).length;
      const lastMsg = chat.messages[chat.messages.length - 1];
      result.push({
        chatId,
        title: chat.meta.title || `Чат с ${other}`,
        online: isOnline(other),
        unreadCount,
        lastMessage: lastMsg
          ? (lastMsg.from === userId ? `Вы: ${lastMsg.text||'[файл]'}` : (lastMsg.text||'[файл]'))
          : ''
      });
    }
  }
  res.json(result);
});

// 2) POST /api/create-chat { from, to }
app.post('/api/create-chat', async (req, res) => {
  const { from, to, meta } = req.body;
  if (!from || !to || from === to) return res.status(400).json({ error: 'Invalid participants' });
  if (!await isAdmin(from)) return res.status(403).json({ error: 'Only admin can create chats' });

  const chatId = getChatId(from, to);
  if (!chatDB.chats[chatId]) {
    chatDB.chats[chatId] = {
      participants: [String(from), String(to)],
      messages: [],
      meta: { ...meta, createdAt: Date.now() }
    };
    markOnline(from);
    markOnline(to);
    saveDB();
  }
  res.json({ chatId });
});

// 3) POST /api/messages/send (text + replyTo)
app.post('/api/messages/send', (req, res) => {
  const { chatId, from, to, text, replyTo } = req.body;
  if (!chatId || !from || !to || !text) return res.status(400).json({ error: 'Invalid payload' });
  const chat = chatDB.chats[chatId];
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  const msg = {
    id:   `${Date.now()}_${Math.random()*1000|0}`,
    from: String(from),
    to:   String(to),
    text,
    file: null,
    ts:   Date.now(),
    read: false,
    replyTo: replyTo || null
  };
  chat.messages.push(msg);
  // пометим всем кроме отправителя как непрочитанное
  chat.participants.forEach(p => { if (p !== String(from)) msg.read = false; });
  markOnline(from);
  saveDB();
  res.json({ success: true, message: msg });
});

// 3b) POST /api/messages/send-file (multipart + text comment)
app.post('/api/messages/send-file', upload.single('file'), (req, res) => {
  const { chatId, from, to, text, replyTo } = req.body;
  if (!chatId || !from || !to || !req.file) return res.status(400).json({ error: 'Invalid payload' });
  const chat = chatDB.chats[chatId];
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  const fileUrl = `/files/${req.file.filename}`;
  const msg = {
    id:      `${Date.now()}_${Math.random()*1000|0}`,
    from:    String(from),
    to:      String(to),
    text:    text || null,
    file:    fileUrl,
    ts:      Date.now(),
    read:    false,
    replyTo: replyTo || null
  };
  chat.messages.push(msg);
  markOnline(from);
  saveDB();
  res.json({ success: true, message: msg });
});

// 4) GET /api/messages?chatId=xxx&userId=yyy
app.get('/api/messages', (req, res) => {
  const chatId = String(req.query.chatId || '');
  const userId = String(req.query.userId || '');
  if (!chatId || !userId) return res.status(400).json({ error: 'Missing chatId or userId' });
  const chat = chatDB.chats[chatId];
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  markOnline(userId);
  chat.messages.forEach(m => { if (m.to === userId) m.read = true; });
  saveDB();
  res.json(chat.messages);
});

// 5) GET /api/status?userId=xxx
app.get('/api/status', (req, res) => {
  const userId = String(req.query.userId || '');
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  res.json({ online: isOnline(userId) });
});

// 6) POST /api/chat/:chatId/add-master { managerId, masterId }
app.post('/api/chat/:chatId/add-master', async (req, res) => {
  const { managerId, masterId } = req.body;
  const chat = chatDB.chats[req.params.chatId];
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (!await isAdmin(managerId)) return res.status(403).json({ error: 'Only admin can add' });

  if (!chat.participants.includes(String(masterId))) {
    chat.participants.push(String(masterId));
    markOnline(masterId);
    saveDB();
  }
  res.json({ success: true });
});

// Static
app.use(express.static(path.join(__dirname, 'public')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

// Start
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
