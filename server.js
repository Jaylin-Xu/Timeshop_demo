// server.js
// =======================================
// Minimal Express + Socket.io + lowdb server
// 最简后端：
// 1. 提供静态页面（public）
// 2. 维护账号数据（lowdb + JSON 文件）
// 3. 汇总全站 totalTime，并通过 socket.io
//    推送 totalTime 和 Online Lounge 的在线列表
//
// 当前认证方式仅用于课堂实验：
// username + password 明文校验。
// 更规范的做法可以参考：
// https://www.w3schools.com/nodejs/nodejs_api_auth.asp
// =======================================

import express from 'express';
import http from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'path';
import { fileURLToPath } from 'url';

// 在 ES module 环境下构造 __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- 基础服务 ----------
const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server);

// ---------- lowdb 初始化 ----------
// db.json 与 server.js 同级
const dbFile = path.join(__dirname, 'db.json');
const adapter = new JSONFile(dbFile);

// db.data 默认结构
const db = new Low(adapter, { totalTime: 0, users: [] });
await db.read();
if (!db.data) db.data = { totalTime: 0, users: [] };
if (!db.data.users) db.data.users = [];

// ---------- 在线用户（仅存于内存，断线即清空） ----------
// Map<socketId, { username, totalSeconds, coins, lastCards, hideCoins }>
const onlineUsers = new Map();

// 将多个连接按照用户名聚合成一条记录，推送到前端 Online Lounge
function broadcastOnlineUsers() {
  const grouped = new Map();

  for (const info of onlineUsers.values()) {
    const { username, totalSeconds, coins, lastCards, hideCoins } = info;
    if (!username) continue;

    if (!grouped.has(username)) {
      grouped.set(username, {
        username,
        totalSeconds: Number(totalSeconds) || 0,
        coins: Number(coins) || 0,
        lastCards: Array.isArray(lastCards) ? lastCards.slice(-3) : [],
        hideCoins: !!hideCoins
      });
    } else {
      const g = grouped.get(username);
      g.totalSeconds = Math.max(g.totalSeconds, Number(totalSeconds) || 0);
      g.coins = Math.max(g.coins, Number(coins) || 0);
      g.hideCoins = g.hideCoins || !!hideCoins;
      if (!g.lastCards.length) {
        g.lastCards = Array.isArray(lastCards) ? lastCards.slice(-3) : [];
      }
    }
  }

  io.emit('onlineUsers', Array.from(grouped.values()));
}

// ---------- 中间件 ----------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 工具函数：根据用户名查找用户
function findUser(username) {
  return db.data.users.find((u) => u.username === username);
}

// 新账号默认状态
function defaultUserState() {
  return {
    totalSeconds: 0,
    coinsSpent: 0,
    cards: [],
    coinsClaimed: 0,
    coinEventsTriggered: 0
  };
}

// 首页：返回 public/index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- 注册 ----------
app.post('/auth/signup', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({
      error: '用户名和密码不能为空 / Username and password are required.'
    });
  }

  if (findUser(username)) {
    return res.status(400).json({
      error: '用户名已存在 / Username already exists.'
    });
  }

  const user = {
    username,
    password, // 课堂实验：明文保存；正式项目应存密码 hash。
    state: defaultUserState()
  };

  db.data.users.push(user);
  await db.write();

  res.json({ username, state: user.state });
});

// ---------- 登录 ----------
app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({
      error: '用户名和密码不能为空 / Username and password are required.'
    });
  }

  const user = findUser(username);
  if (!user || user.password !== password) {
    return res.status(400).json({
      error: '用户名或密码错误 / Incorrect username or password.'
    });
  }

  if (!user.state) {
    user.state = defaultUserState();
    await db.write();
  }

  res.json({ username, state: user.state });
});

// ---------- 同步账号状态 ----------
// 前端定期 POST /api/state：{ username, password, state }
// 服务器：
// 1. 根据 totalSeconds 的增量更新全站 totalTime
// 2. 持久化每个账号的最新 state
// 3. 广播 totalTime
//
// 计时循环使用 setTimeout 实现，参考：
// https://developer.mozilla.org/en-US/docs/Web/API/Window/setTimeout
app.post('/api/state', async (req, res) => {
  const { username, password, state } = req.body || {};
  if (!username || !password || !state) {
    return res.status(400).json({
      error: '缺少必要字段 / Required fields are missing.'
    });
  }

  const user = findUser(username);
  if (!user || user.password !== password) {
    return res.status(400).json({
      error: '认证失败 / Authentication failed.'
    });
  }

  const oldState = user.state || defaultUserState();

  const newState = {
    totalSeconds: Number(state.totalSeconds) || 0,
    coinsSpent: Number(state.coinsSpent) || 0,
    cards: Array.isArray(state.cards) ? state.cards : [],
    coinsClaimed: Number(state.coinsClaimed) || 0,
    coinEventsTriggered: Number(state.coinEventsTriggered) || 0
  };

  const delta = Math.max(0, newState.totalSeconds - (oldState.totalSeconds || 0));
  db.data.totalTime += delta;
  user.state = newState;

  await db.write();

  io.emit('totalTime', db.data.totalTime);
  res.json({ ok: true, state: user.state });
});

// ---------- Socket.io：totalTime + 在线列表 ----------
io.on('connection', (socket) => {
  // 新连接直接发送当前 totalTime
  socket.emit('totalTime', db.data.totalTime);

  // presence:update 用于维护 Online Lounge
  socket.on('presence:update', (payload) => {
    if (!payload) return;
    const { username, totalSeconds, coins, lastCards, hideCoins } = payload;
    if (!username) return;

    onlineUsers.set(socket.id, {
      username,
      totalSeconds: Number(totalSeconds) || 0,
      coins: Number(coins) || 0,
      lastCards: Array.isArray(lastCards) ? lastCards.slice(-3) : [],
      hideCoins: !!hideCoins
    });

    broadcastOnlineUsers();
  });

  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    broadcastOnlineUsers();
  });
});

// ---------- 启动服务 ----------
const PORT = process.env.PORT || 6020;
server.listen(PORT, () => {
  console.log(`Server listening at http://localhost:${PORT}`);
});
