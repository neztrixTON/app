// server.js
// ------------------------------
// Обновлённый Node.js/Express-сервер с поддержкой:
// 1) reply по двойному нажатию
// 2) комментарий к файлу (text в send-file)

const express     = require('express');
const fs          = require('fs');
const path        = require('path');
const bodyParser  = require('body-parser');
const cors        = require('cors');
const multer      = require('multer');

const app  = express();
const PORT = parseInt(process.env.PORT) || 3000;

// Путь к файлу “БД”
const DB_PATH = path.join(__dirname, 'chat-db.json');

// Папка для хранения загруженных файлов
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '_' + file.originalname;
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// Подключаем middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/files', express.static(UPLOAD_DIR)); // отдать загруженные файлы

// --- Инициализация базы (chatDB) ---
let chatDB = { chats: {}, users: {} };
if (fs.existsSync(DB_PATH)) {
  try {
    chatDB = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch (e) {
    console.error('Ошибка при чтении chat-db.json, создаём новый:', e);
    chatDB = { chats: {}, users: {} };
    fs.writeFileSync(DB_PATH, JSON.stringify(chatDB, null, 2));
  }
} else {
  fs.writeFileSync(DB_PATH, JSON.stringify(chatDB, null, 2));
}

function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(chatDB, null, 2));
}

// Генерация chatId
function getChatId(u1, u2) {
  const sorted = [u1, u2].sort();
  return `${sorted[0]}_${sorted[1]}`;
}

// Обновляем “lastSeen” пользователя
function markOnline(userId) {
  if (!chatDB.users[userId]) chatDB.users[userId] = { lastSeen: Date.now() };
  else chatDB.users[userId].lastSeen = Date.now();
  saveDB();
}

function isOnline(userId) {
  const info = chatDB.users[userId];
  if (!info) return false;
  return (Date.now() - info.lastSeen) < 30000;
}

// --- API ---

// 1) GET /api/chats?userId=xxx
app.get('/api/chats', (req, res) => {
  const userId = String(req.query.userId || '');
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  markOnline(userId);

  const result = [];
  for (const chatId in chatDB.chats) {
    const chat = chatDB.chats[chatId];
    if (chat.participants.includes(userId)) {
      const other = chat.participants.find(p => p !== userId);
      const unreadCount = chat.messages.reduce((cnt, m) => {
        if (m.to === userId && !m.read) return cnt + 1;
        return cnt;
      }, 0);
      const lastMsg = chat.messages[chat.messages.length - 1];
      const lastMessage = lastMsg
        ? (lastMsg.from === userId ? `Вы: ${lastMsg.text || '[файл]'}` : (lastMsg.text || '[файл]'))
        : '';
      result.push({
        chatId,
        title: `Чат с ${other}`,
        online: isOnline(other),
        unreadCount,
        lastMessage
      });
    }
  }
  return res.json(result);
});

// 2) POST /api/create-chat { from, to }
app.post('/api/create-chat', (req, res) => {
  const { from, to } = req.body;
  if (!from || !to || from === to) return res.status(400).json({ error: 'Invalid participants' });
  const u1 = String(from), u2 = String(to);
  const chatId = getChatId(u1, u2);

  if (!chatDB.chats[chatId]) {
    chatDB.chats[chatId] = { participants: [u1, u2], messages: [] };
    if (!chatDB.users[u1]) chatDB.users[u1] = { lastSeen: 0 };
    if (!chatDB.users[u2]) chatDB.users[u2] = { lastSeen: 0 };
    saveDB();
  }
  return res.json({ chatId });
});

// 3) POST /api/messages/send (текст + replyTo)
app.post('/api/messages/send', (req, res) => {
  const { chatId, from, to, text, replyTo } = req.body;
  if (!chatId || !from || !to || (!text && !('file' in req.body))) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
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
  return res.json({ success: true, message: msg });
});

// 3b) POST /api/messages/send-file (multipart + комментарий)
app.post('/api/messages/send-file', upload.single('file'), (req, res) => {
  const { chatId, from, to, replyTo, text } = req.body;
  if (!chatId || !from || !to || !req.file) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const chat = chatDB.chats[chatId];
  if (!chat) return res.status(404).json({ error: 'Chat not found' });

  const fileUrl = `/files/${req.file.filename}`;
  const msg = {
    id: Date.now() + '_' + Math.floor(Math.random() * 1000),
    from: String(from),
    to: String(to),
    text: text || null,       // Здесь сохраняем комментарий к файлу (или null)
    file: fileUrl,
    ts: Date.now(),
    read: false,
    replyTo: replyTo || null
  };
  chat.messages.push(msg);
  saveDB();
  return res.json({ success: true, message: msg });
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
  return res.json(chat.messages);
});

// 5) GET /api/status?userId=xxx
app.get('/api/status', (req, res) => {
  const userId = String(req.query.userId || '');
  if (!userId) return res.status(400).json({ error: 'Missing userId' });
  return res.json({ online: isOnline(userId) });
});

// Любые другие запросы → index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Mini App Server listening on port ${PORT}`);
});
