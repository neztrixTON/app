// server.js
const express     = require('express');
const fs          = require('fs');
const path        = require('path');
const bodyParser  = require('body-parser');
const cors        = require('cors');
const multer      = require('multer');

const app  = express();
const PORT = parseInt(process.env.PORT) || 3000;
const DB_PATH = path.join(__dirname, 'chat-db.json');
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/files', express.static(UPLOAD_DIR));

// Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, Date.now() + '_' + file.originalname)
});
const upload = multer({ storage });

// DB init
let chatDB = { chats: {}, users: {} };
if (fs.existsSync(DB_PATH)) {
  try { chatDB = JSON.parse(fs.readFileSync(DB_PATH)); }
  catch { saveDB(); }
} else saveDB();

function saveDB() {
  fs.writeFileSync(DB_PATH, JSON.stringify(chatDB, null, 2));
}

// Online tracking
function markOnline(userId) {
  chatDB.users[userId] = Date.now();
  saveDB();
}
function isOnline(userId) {
  const last = chatDB.users[userId];
  return last && (Date.now() - last) < 30000;
}

// GET /api/chats?userId=xxx
app.get('/api/chats', (req, res) => {
  const userId = String(req.query.userId||'');
  if (!userId) return res.status(400).json({ error:'Missing userId' });
  markOnline(userId);

  const result = [];
  for (const [chatId, chat] of Object.entries(chatDB.chats)) {
    const part = chat.participants.map(p=>p.id);
    if (!part.includes(userId)) continue;
    const other = chat.participants.filter(p=>p.id!==userId);
    const unread = chat.messages.filter(m=>m.to===userId && !m.read).length;
    const lastMsg = chat.messages.slice(-1)[0] || {};
    result.push({
      chatId,
      title: `Чат по заявке #${chat.meta?.requestId||'?'}`,
      online: other.some(p=>isOnline(p.id)),
      unreadCount: unread,
      lastMessage: lastMsg.text||'(файл)',
      meta: chat.meta
    });
  }
  res.json(result);
});

// POST /api/create-chat
app.post('/api/create-chat', (req, res) => {
  const { from, to, meta={}, role='manager' } = req.body;
  if (!from||!to) return res.status(400).json({ error:'Invalid participants' });
  const chatId = String(to);
  if (!chatDB.chats[chatId]) {
    chatDB.chats[chatId] = {
      participants: [
        { id: String(from), role },
        { id: String(to),   role:'client' }
      ],
      messages: [],
      meta
    };
    saveDB();
  }
  res.json({ chatId });
});

// POST /api/add-to-chat
app.post('/api/add-to-chat', (req, res) => {
  const { chatId, userId, role } = req.body;
  const chat = chatDB.chats[chatId];
  if (!chat) return res.status(404).json({ error:'Chat not found' });
  if (!chat.participants.find(p=>p.id===String(userId))) {
    chat.participants.push({ id:String(userId), role });
    saveDB();
  }
  res.json({ success:true });
});

// POST /api/messages/send
app.post('/api/messages/send', (req,res)=>{
  const { chatId, from, to, text, replyTo } = req.body;
  const chat = chatDB.chats[chatId];
  if (!chat) return res.status(404).json({ error:'Chat not found' });
  const msg = {
    id: Date.now()+'_'+Math.random().toString().slice(2,6),
    from:String(from), to:String(to), text:text||null,
    file:null, ts:Date.now(), read:false, replyTo:replyTo||null
  };
  chat.messages.push(msg);
  saveDB();
  res.json({ success:true, message:msg });
});

// POST /api/messages/send-file
app.post('/api/messages/send-file', upload.single('file'), (req,res)=>{
  const { chatId, from, to, replyTo, text } = req.body;
  const chat = chatDB.chats[chatId];
  if (!chat) return res.status(404).json({ error:'Chat not found' });
  const fileUrl = `/files/${req.file.filename}`;
  const msg = {
    id: Date.now()+'_'+Math.random().toString().slice(2,6),
    from:String(from), to:String(to), text:text||null,
    file:fileUrl, ts:Date.now(), read:false, replyTo:replyTo||null
  };
  chat.messages.push(msg);
  saveDB();
  res.json({ success:true, message:msg });
});

// GET /api/messages?chatId=xxx&userId=yyy
app.get('/api/messages',(req,res)=>{
  const chatId=String(req.query.chatId||''), userId=String(req.query.userId||'');
  const chat=chatDB.chats[chatId];
  if(!chat) return res.status(404).json({ error:'Chat not found' });
  markOnline(userId);
  chat.messages.forEach(m=>{ if(m.to===userId) m.read=true; });
  saveDB();
  res.json(chat.messages);
});

// GET /api/status?userId=xxx
app.get('/api/status',(req,res)=>{
  const userId=String(req.query.userId||'');
  if(!userId) return res.status(400).json({ error:'Missing userId' });
  res.json({ online: isOnline(userId) });
});

// Catch-all → index.html
app.get('*',(req,res)=>{
  res.sendFile(path.join(__dirname,'public/index.html'));
});

app.listen(PORT,()=>console.log(`Server running on ${PORT}`));
