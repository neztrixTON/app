// server.js
// ------------------------------
// Минимальный Node.js/Express-сервер для Telegram WebApp Chat
// Хранит чаты и сообщения в chat-db.json (in-memory + файл)

// Библиотеки
const express     = require('express');
const fs          = require('fs');
const path        = require('path');
const bodyParser  = require('body-parser');
const cors        = require('cors');

const app  = express();
const PORT = parseInt(process.env.PORT) || 3000;

// Путь к файлу “БД”
const DB_PATH = path.join(__dirname, 'chat-db.json');

// Подключаем middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Инициализация базы (chatDB) ---
let chatDB = { chats: {}, users: {} };
// Если файл существует — читаем, иначе создаём новый пустой
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

// Функция для сохранения chatDB в файл
function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(chatDB, null, 2));
}

// Генерация chatId по двум userId (чтобы порядок не имел значения)
function getChatId(u1, u2) {
  const sorted = [u1, u2].sort();
  return `${sorted[0]}_${sorted[1]}`;
}

// Обновляем “lastSeen” пользователя (для онлайн/офлайн)
function markOnline(userId) {
  if (!chatDB.users[userId]) {
    chatDB.users[userId] = { lastSeen: Date.now() };
  } else {
    chatDB.users[userId].lastSeen = Date.now();
  }
  saveDB();
}

// Проверка, онлайн ли пользователь (заходил ли <30 сек назад)
function isOnline(userId) {
  const info = chatDB.users[userId];
  if (!info) return false;
  return (Date.now() - info.lastSeen) < 30 * 1000;
}

// --- API ENDPOINTS ---
// 1) GET /api/chats?userId=xxx
//    Возвращает список чатов, в которых участвует userId.
//    Для каждого чата отдаёт:
//      { chatId, title, online, unreadCount, lastMessage }
app.get('/api/chats', (req, res) => {
  const userId = String(req.query.userId || '');
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }
  // Помечаем его онлайн
  markOnline(userId);

  const result = [];
  // Перебираем все чаты в chatDB
  for (const chatId in chatDB.chats) {
    const chat = chatDB.chats[chatId];
    // Если текущий пользователь — участник этого чата:
    if (chat.participants.includes(userId)) {
      // Находим “другого” собеседника:
      const other = chat.participants.find(p => p !== userId);
      // Считаем непрочитанные сообщения userId (messages.to === userId && read === false)
      const unreadCount = chat.messages.reduce((cnt, m) => {
        if (m.to === userId && !m.read) return cnt + 1;
        return cnt;
      }, 0);
      // Берём последний текст (если есть)
      const lastMsgObj = chat.messages[chat.messages.length - 1];
      const lastMessage = lastMsgObj
        ? (lastMsgObj.from === userId ? `Вы: ${lastMsgObj.text}` : lastMsgObj.text)
        : '';

      // Формируем объект для фронтенда
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


// 2) POST /api/create-chat
//    Тело JSON: { from, to }
//    Создаёт чат (если ещё нет) между двумя ID и возвращает { chatId }.
app.post('/api/create-chat', (req, res) => {
  const { from, to } = req.body;
  if (!from || !to || from === to) {
    return res.status(400).json({ error: 'Invalid participants' });
  }
  const u1 = String(from);
  const u2 = String(to);
  const chatId = getChatId(u1, u2);

  // Если чат не существует — создаём
  if (!chatDB.chats[chatId]) {
    chatDB.chats[chatId] = {
      participants: [u1, u2],
      messages: []  // каждое сообщение: { from, to, text, ts, read }
    };
    // Убедимся, что оба пользователя есть в users для статуса
    if (!chatDB.users[u1]) chatDB.users[u1] = { lastSeen: 0 };
    if (!chatDB.users[u2]) chatDB.users[u2] = { lastSeen: 0 };
    saveDB();
  }

  return res.json({ chatId });
});


// 3) POST /api/messages/send
//    Тело JSON: { chatId, from, to, text }
//    Добавляет сообщение в chatDB.chats[chatId].messages с read=false.
app.post('/api/messages/send', (req, res) => {
  const { chatId, from, to, text } = req.body;
  if (!chatId || !from || !to || !text) {
    return res.status(400).json({ error: 'Invalid payload' });
  }
  const chat = chatDB.chats[chatId];
  if (!chat) {
    return res.status(404).json({ error: 'Chat not found' });
  }
  // Добавляем сообщение
  const msg = {
    from: String(from),
    to: String(to),
    text: String(text),
    ts: Date.now(),
    read: false
  };
  chat.messages.push(msg);
  saveDB();
  return res.json({ success: true });
});


// 4) GET /api/messages?chatId=xxx&userId=yyy
//    Возвращает все сообщения из chatDB.chats[chatId].messages.
//    При этом помечает все сообщения, где m.to === userId && read===false, как прочитанные.
app.get('/api/messages', (req, res) => {
  const chatId = String(req.query.chatId || '');
  const userId = String(req.query.userId || '');
  if (!chatId || !userId) {
    return res.status(400).json({ error: 'Missing chatId or userId' });
  }
  const chat = chatDB.chats[chatId];
  if (!chat) {
    return res.status(404).json({ error: 'Chat not found' });
  }
  // Помечаем его онлайн (он ведь открыл чат)
  markOnline(userId);

  // Помечаем все сообщения, адресованные ему, как прочитанные
  for (const m of chat.messages) {
    if (m.to === userId) {
      m.read = true;
    }
  }
  saveDB();
  return res.json(chat.messages);
});


// 5) GET /api/status?userId=xxx
//    Возвращает { online: true/false } для userId
app.get('/api/status', (req, res) => {
  const userId = String(req.query.userId || '');
  if (!userId) {
    return res.status(400).json({ error: 'Missing userId' });
  }
  return res.json({ online: isOnline(userId) });
});


// Любой прочий запрос → отдать index.html (чтобы WebApp мог сам обрабатывать пути)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});


// Запуск сервера
app.listen(PORT, () => {
  console.log(`Mini App Server listening on port ${PORT}`);
});
