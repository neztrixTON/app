// server.js
const express     = require('express');
const path        = require('path');
const bodyParser  = require('body-parser');
const cors        = require('cors');

const app = express();
const PORT   = parseInt(process.env.PORT || '3000');
const DOMAIN = process.env.DOMAIN || 'https://localhost';
//   ↑ Убедитесь, что это ваш публичный HTTPS-адрес веб-сервера!

// --- Хранилища “in-memory” ---
const messagesStore = {};     // { chatId: [ { from, to, text, ts }, … ] }
const userChats     = {};     // { userId: Set<chatId> }
const lastSeen      = {};     // { userId: timestamp_ms }
const lastReadIndex = {};     // { chatId: { userId: lastReadIdx (number) } }

// Если чат ещё не создан, создаём его “по требованию”:
function ensureChatExists(chatId, userA, userB) {
  if (!messagesStore[chatId]) {
    messagesStore[chatId] = [];
    lastReadIndex[chatId] = {};
    // Новый чат – помечаем, что оба пользователя ничего не читали: lastRead = 0
    lastReadIndex[chatId][userA] = 0;
    lastReadIndex[chatId][userB] = 0;
  }
  // Привязываем чат к каждому из участников:
  if (!userChats[userA]) userChats[userA] = new Set();
  if (!userChats[userB]) userChats[userB] = new Set();
  userChats[userA].add(chatId);
  userChats[userB].add(chatId);
}

// Помощник: вычисляем chatId по двум userId (чтобы он был одинаков для (u1,u2) и (u2,u1))
function getChatId(u1, u2) {
  const sorted = [u1, u2].sort();
  return `${sorted[0]}_${sorted[1]}`;
}

// Помечаем пользователя “посетившим” приложение сейчас:
function markUserSeen(userId) {
  lastSeen[userId] = Date.now();
}

// Проверка, онлайн ли пользователь (если он заходил в WebApp < 30 сек назад)
function isOnline(userId) {
  const ts = lastSeen[userId];
  if (!ts) return false;
  return (Date.now() - ts) < 30 * 1000;
}

// CORS + JSON парсер + статика из /public
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));


/**
 * GET /api/chats?userId=xxx
 * Возвращает список чатов, в которых участвует userId.
 * Для каждого чата отдаёт:
 *   { chatId, title, online, unreadCount, lastMessage }
 */
app.get('/api/chats', (req, res) => {
  const userId = String(req.query.userId || '');
  if (!userId) {
    return res.status(400).json({ error: 'Не указан userId' });
  }

  // Помечаем, что пользователь зашёл сейчас – значит “онлайн”
  markUserSeen(userId);

  // Если у пользователя нет ни одного чата – возвращаем пустой массив
  const chatSet = userChats[userId];
  if (!chatSet || chatSet.size === 0) {
    return res.json([]);
  }

  const result = [];
  for (const chatId of chatSet) {
    const msgs = messagesStore[chatId] || [];
    const total = msgs.length;

    // Кто “второй” собеседник
    const [u1, u2] = chatId.split('_');
    const other = (u1 === userId ? u2 : u1);

    // Последнее сообщение (если есть)
    let lastMessageText = '';
    if (msgs.length > 0) {
      const last = msgs[msgs.length - 1];
      lastMessageText = `${ last.from === userId ? 'Вы: ' : '' }${ last.text }`;
    }

    // Считаем непрочитанные сообщения для этого пользователя
    const lastRead = (lastReadIndex[chatId] && lastReadIndex[chatId][userId]) || 0;
    const unreadCount = Math.max(0, total - lastRead);

    // Онлайн/офлайн статусы собеседника
    const otherOnline = isOnline(other);

    result.push({
      chatId,
      title: `Чат с ${other}`,
      online: otherOnline,
      unreadCount,
      lastMessage: lastMessageText
    });
  }

  // Возвращаем список чатов
  return res.json(result);
});


/**
 * GET /api/messages?chatId=xxx&userId=yyy
 * Возвращает все сообщения в чате chatId. 
 * При этом обновляет lastReadIndex[chatId][userId] = totalMessages,
 * чтобы пометить все эти сообщения как “прочитанные” для userId.
 */
app.get('/api/messages', (req, res) => {
  const chatId = req.query.chatId || '';
  const userId = String(req.query.userId || '');
  if (!chatId || !userId) {
    return res.status(400).json({ error: 'Не указан chatId или userId' });
  }

  // Если чата нет – 404
  if (!messagesStore[chatId]) {
    return res.status(404).json({ error: 'Chat not found' });
  }

  // Помечаем пользователя “онлайн” (он открыл чат)
  markUserSeen(userId);

  const msgs = messagesStore[chatId];
  // Обновляем индекс прочтения
  if (!lastReadIndex[chatId]) lastReadIndex[chatId] = {};
  lastReadIndex[chatId][userId] = msgs.length;

  return res.json(msgs);
});


/**
 * POST /api/messages/send
 * Тело JSON: { from, to, text }
 * Отправляет сообщение из from → to (новый либо существующий чат).
 * Если чата ещё нет, создаёт его и привязывает к обоим пользователям.
 * Возвращает { success: true, message: { from, to, text, ts } }.
 */
app.post('/api/messages/send', (req, res) => {
  const { from, to, text } = req.body;
  if (!from || !to || typeof text !== 'string') {
    return res.status(400).json({ error: 'Bad request' });
  }
  const userA = String(from);
  const userB = String(to);
  // Вычисляем chatId
  const chatId = getChatId(userA, userB);

  // Если чата нет – создаём
  ensureChatExists(chatId, userA, userB);

  // Добавляем сообщение
  const timestamp = new Date().toISOString();
  const msgObj = { from: userA, to: userB, text, ts: timestamp };
  messagesStore[chatId].push(msgObj);

  return res.json({ success: true, message: msgObj });
});


/**
 * GET /api/status?userId=xxx
 * Возвращает { online: true/false }, исходя из lastSeen.
 */
app.get('/api/status', (req, res) => {
  const userId = String(req.query.userId || '');
  if (!userId) {
    return res.status(400).json({ error: 'Не указан userId' });
  }
  const online = isOnline(userId);
  return res.json({ online });
});


// Любой другой запрос отдаём index.html (чтобы WebApp мог “управлять маршрутами”)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/index.html'));
});


app.listen(PORT, () => {
  console.log(`Сервер запущен: ${DOMAIN}:${PORT}`);
});
