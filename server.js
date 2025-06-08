// server.js
// ------------------------------
// Обновлённый Node.js/Express-сервер с поддержкой:
// 1) метаданных chat.meta (requestId, type, address, createdAt)
// 2) участников с ролями (participants: [{id,role},…])
// 3) эндпоинта POST /api/add-to-chat

const express     = require('express');
const fs          = require('fs');
const path        = require('path');
const bodyParser  = require('body-parser');
const cors        = require('cors');
const multer      = require('multer');

const app  = express();
const PORT = parseInt(process.env.PORT) || 3000;

// Путь к файлу “БД”
const DB_PATH    = path.join(__dirname, 'chat-db.json');
// Папка для хранения загруженных файлов
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// Подключаем middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/files', express.static(UPLOAD_DIR)); // отдать загруженные файлы

// Multer для загрузки файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage });

// Инициализация БД
let chatDB = { chats: {}, users: {} };
if (fs.existsSync(DB_PATH)) {
  try {
    chatDB = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    console.error('Ошибка при чтении chat-db.json, создаём новый:', e);
    saveDB();
  }
} else {
  saveDB();
}

function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(chatDB, null, 2));
}

// Онлайн‑статус
function markOnline(userId) {
  chatDB.users[userId] = Date.now();
  saveDB();
}
function isOnline(userId) {
  const last = chatDB.users[userId];
  return last && (Date.now() - last) < 30000;
}

// API

// 1) GET /api/chats?userId=xxx
app.get('/api/chats', (req, res) => {
  const userId = String(req.query.userId || '');
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  markOnline(userId);

  const result = [];
  for (const [chatId, chat] of Object.entries(chatDB.chats)) {
    const partIds = chat.participants.map(p => p.id);
    if (!partIds.includes(userId)) continue;
    // остальные участники
    const others = chat.participants.filter(p => p.id !== userId);
    const unreadCount = chat.messages.reduce((cnt, m) => {
      if (m.to === userId && !m.read) return cnt + 1;
      return cnt;
    }, 0);
    const lastMsg = chat.messages.slice(-1)[0] || {};
    result.push({
      chatId,
      title: `Чат по заявке #${chat.meta?.requestId || '?'}`,
      online: others.some(o => isOnline(o.id)),
      unreadCount,
      lastMessage: lastMsg.text || '[файл]',
      meta: chat.meta || {}
    });
  }
  res.json(result);
});

// 2) POST /api/create-chat { from, to, meta, role }
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
  res.json({ chatId });
});

// 3) POST /api/add-to-chat { chatId, userId, role }
app.post('/api/add-to-chat', (req, res) => {
  const { chatId, userId, role } = req.body;
  const chat = chatDB.chats[chatId];
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  if (!chat.participants.find(p => p.id === String(userId))) {
    chat.participants.push({ id: String(userId), role });
    saveDB();
  }
  res.json({ success: true });
});

// 4) POST /api/messages/send (текст + replyTo)
app.post('/api/messages/send', (req, res) => {
  const { chatId, from, to, text, replyTo } = req.body;
  const chat = chatDB.chats[chatId];
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  const msg = {
    id: Date.now() + '_' + Math.floor(Math.random() * 1000),
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
  res.json({ success: true, message: msg });
});

// 5) POST /api/messages/send-file (multipart + комментарий)
app.post('/api/messages/send-file', upload.single('file'), (req, res) => {
  const { chatId, from, to, replyTo, text } = req.body;
  const chat = chatDB.chats[chatId];
  if (!chat) return res.status(404).json({ error: 'Chat not found' });
  const fileUrl = `/files/${req.file.filename}`;
  const msg = {
    id: Date.now() + '_' + Math.floor(Math.random() * 1000),
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
  res.json({ success: true, message: msg });
});

// 6) GET /api/messages?chatId=xxx&userId=yyy
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

// 7) GET /api/status?userId=xxx
app.get('/api/status', (req, res) => {
  const userId = String(req.query.userId || '');
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  res.json({ online: isOnline(userId) });
});

// Любые другие запросы → public/index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Mini App Server listening on port ${PORT}`);
});
