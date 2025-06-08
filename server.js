// server.js
// ===========================
// Node.js/Express + Bot‑token integration
// 1) хранит participants с ролями и meta (requestId, …)
// 2) при POST /api/messages/send(-file) шлёт через Telegram API
//    уведомление всем, кроме отправителя.
// 3) отдаёт isAdmin для WebApp, чтобы показывать кнопку «Добавить участника».
// ===========================

const express    = require('express');
const fs         = require('fs');
const path       = require('path');
const bodyParser = require('body-parser');
const cors       = require('cors');
const multer     = require('multer');
const fetch      = require('node-fetch'); // npm i node-fetch@2
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

// Multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage });

// Simple JSON «DB»
let chatDB = { chats: {}, users: {}, admins: [] };
if (fs.existsSync(DB_PATH)) {
  try { chatDB = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
  catch (e) { console.error(e); saveDB(); }
} else saveDB();

function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(chatDB, null, 2));
}

// Mark user online
function markOnline(userId) {
  chatDB.users[userId] = Date.now();
  saveDB();
}
function isOnline(userId) {
  const last = chatDB.users[userId];
  return last && (Date.now() - last) < 30000;
}

// Helpers
async function notifyParticipant(to, text, chatId) {
  const url = `${TG_API}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type':'application/json' },
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
// Возвращает список чатов + meta + isAdmin
app.get('/api/chats', (req, res) => {
  const userId = String(req.query.userId||'');
  if (!userId) return res.status(400).json({error:'Missing userId'});
  markOnline(userId);

  const isAdmin = chatDB.admins.includes(userId);
  const result = [];
  for (const [chatId, chat] of Object.entries(chatDB.chats)) {
    const partIds = chat.participants.map(p=>p.id);
    if (!partIds.includes(userId)) continue;
    const other = chat.participants.find(p=>p.id!==userId) || {};
    const unread = chat.messages.filter(m=>m.to===userId && !m.read).length;
    const lastMsg = chat.messages.slice(-1)[0] || {};
    result.push({
      chatId,
      title: `Чат по заявке #${chat.meta.requestId}`,
      online: partIds.filter(id=>id!==userId).some(isOnline),
      unreadCount: unread,
      lastMessage: lastMsg.text || '[файл]',
      meta: chat.meta,
      isAdmin
    });
  }
  res.json(result);
});

// POST /api/create-chat {from,to,meta,role}
app.post('/api/create-chat', (req,res)=>{
  const {from,to,meta={},role='manager'} = req.body;
  if(!from||!to) return res.status(400).json({error:'Invalid'});
  const chatId = String(to);
  if(!chatDB.chats[chatId]) {
    chatDB.chats[chatId] = {
      participants: [
        {id:String(from),role},
        {id:String(to),role:'client'}
      ],
      messages: [],
      meta
    };
    saveDB();
  }
  // записываем админа, если новый менеджер
  if(role !== 'client' && !chatDB.admins.includes(String(from))) {
    chatDB.admins.push(String(from));
    saveDB();
  }
  res.json({chatId});
});

// POST /api/add-to-chat {chatId,userId,role}
app.post('/api/add-to-chat',(req,res)=>{
  const {chatId,userId,role} = req.body;
  const chat = chatDB.chats[chatId];
  if(!chat) return res.status(404).json({error:'Chat not found'});
  if(!chat.participants.find(p=>p.id===String(userId))){
    chat.participants.push({id:String(userId),role});
    saveDB();
  }
  // если новый админ/менеджер — регистрируем его
  if(['manager','master','consultant'].includes(role.toLowerCase())){
    if(!chatDB.admins.includes(String(userId))){
      chatDB.admins.push(String(userId));
      saveDB();
    }
  }
  res.json({success:true});
});

// POST /api/messages/send
app.post('/api/messages/send', async (req,res)=>{
  const {chatId,from,to,text,replyTo} = req.body;
  const chat = chatDB.chats[chatId];
  if(!chat) return res.status(404).json({error:'Not found'});
  const msg = {
    id: Date.now()+'_'+Math.random().toString(36).slice(2,6),
    from:String(from),to:String(to),text:text||null,
    file:null, ts:Date.now(), read:false, replyTo:replyTo||null
  };
  chat.messages.push(msg);
  saveDB();
  // notify others
  for(const p of chat.participants){
    if(p.id===String(from)) continue;
    const role = p.role.charAt(0).toUpperCase()+p.role.slice(1);
    await notifyParticipant(p.id, `📩 Новое сообщение от ${role}:\n\n${text}`, chatId);
  }
  res.json({success:true,message:msg});
});

// POST /api/messages/send-file
app.post('/api/messages/send-file', upload.single('file'), async (req,res)=>{
  const {chatId,from,to,replyTo,text} = req.body;
  const chat = chatDB.chats[chatId];
  if(!chat) return res.status(404).json({error:'Not found'});
  const fileUrl = `/files/${req.file.filename}`;
  const msg = {
    id: Date.now()+'_'+Math.random().toString(36).slice(2,6),
    from:String(from),to:String(to),text:text||null,
    file:fileUrl, ts:Date.now(), read:false, replyTo:replyTo||null
  };
  chat.messages.push(msg);
  saveDB();
  // notify others
  for(const p of chat.participants){
    if(p.id===String(from)) continue;
    const role = p.role.charAt(0).toUpperCase()+p.role.slice(1);
    await notifyParticipant(p.id, `📩 Новое сообщение от ${role}:\n\n${text||'[файл]'}`, chatId);
  }
  res.json({success:true,message:msg});
});

// GET /api/messages?chatId=...&userId=...
app.get('/api/messages',(req,res)=>{
  const chatId=String(req.query.chatId||''),userId=String(req.query.userId||'');
  if(!chatId||!userId) return res.status(400).json({error:'Missing'});
  const chat = chatDB.chats[chatId];
  if(!chat) return res.status(404).json({error:'Not found'});
  markOnline(userId);
  // mark read
  chat.messages.forEach(m=>{ if(m.to===userId) m.read=true; });
  saveDB();
  res.json({ messages: chat.messages, meta: chat.meta });
});

// GET /api/status?userId=...
app.get('/api/status',(req,res)=>{
  const userId=String(req.query.userId||'');
  if(!userId) return res.status(400).json({error:'Missing'});
  res.json({online:isOnline(userId)});
});

// catch-all → index.html
app.get('*',(req,res)=>{
  res.sendFile(path.join(__dirname,'public/index.html'));
});

app.listen(PORT,()=>console.log(`Server started on ${PORT}`));
