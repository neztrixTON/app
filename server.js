// server.js
const express = require('express');
const path = require('path');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
const PORT = parseInt(process.env.PORT || '3000');
const DOMAIN = process.env.DOMAIN || `http://localhost`; 
// Замените `https://your-domain.com` на свой реальный публичный URL, 
// где будет развернут этот сервер (с HTTPS!).

// --- Временное (in-memory) хранилище чатов и сообщений ---
const USERS = ['1276928573', '6448269992'];
// Для простоты считаем, что между любыми двумя пользователями создаётся chatId = "user1_user2"
function getChatId(u1, u2) {
  const sorted = [u1, u2].sort();
  return `${sorted[0]}_${sorted[1]}`;
}

// Структура: messagesStore = { chatId1: [ {from, to, text, ts}, ... ], chatId2: [...] }
const messagesStore = {};

// Инициализируем хранилище пустым для единственного чата:
const CHAT_ID = getChatId(USERS[0], USERS[1]);
messagesStore[CHAT_ID] = [];

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1) Получить список чатов для пользователя
app.get('/api/chats', (req, res) => {
  const userId = req.query.userId;
  if (!USERS.includes(userId)) {
    return res.status(404).json({ error: 'User not found' });
  }
  // Для простоты: если user входит в USERS, он есть только в одном чате между двумя.
  const other = USERS.find(u => u !== userId);
  const chatId = getChatId(userId, other);
  res.json([
    {
      chatId,
      title: `Чат с пользователем ${other}`,
      userIds: [userId, other]
    }
  ]);
});

// 2) Получить все сообщения в чате
app.get('/api/messages', (req, res) => {
  const chatId = req.query.chatId;
  if (!chatId || !messagesStore[chatId]) {
    return res.status(404).json({ error: 'Chat not found' });
  }
  res.json(messagesStore[chatId]);
});

// 3) Отправить новое сообщение в чат
app.post('/api/messages/send', (req, res) => {
  const { chatId, from, to, text } = req.body;
  if (!chatId || !from || !to || typeof text !== 'string') {
    return res.status(400).json({ error: 'Bad request' });
  }
  if (!messagesStore[chatId]) {
    return res.status(404).json({ error: 'Chat not found' });
  }
  const timestamp = new Date().toISOString();
  const msg = { from, to, text, ts: timestamp };
  messagesStore[chatId].push(msg);
  res.json({ success: true, message: msg });
});

// Всю папку public отдаём на клиент
app.get('*', (req, res) => {
  // По умолчанию возвращаем index.html — Telegram Web App сам решит, куда идти
  res.sendFile(path.join(__dirname, 'public/index.html'));
});

app.listen(PORT, () => {
  console.log(`Server is running on ${DOMAIN}:${PORT}`);
});
