const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 80;
const JWT_SECRET = process.env.JWT_SECRET || "fallback_secret";

const DB_HOST = process.env.DB_HOST;
const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASS;
const DB_NAME = process.env.DB_NAME;
const DB_PORT = Number(process.env.DB_PORT || 3306);

// 校验环境变量
const required = { DB_HOST, DB_USER, DB_PASS, DB_NAME, JWT_SECRET };
const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
if (missing.length) {
  console.error("缺少必需环境变量：" + missing.join(", "));
  process.exit(1);
}

// 连接 MySQL 数据库池
const pool = mysql.createPool({
  host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, database: DB_NAME,
  waitForConnections: true, connectionLimit: 10, queueLimit: 0, charset: "utf8mb4"
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.CORS_ORIGIN || true, credentials: true } });

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();
const socketUser = new Map();

function httpError(res, status, message) {
  return res.status(status).json({ ok: false, message });
}

function signToken(user) {
  return jwt.sign({ sub: String(user.id), username: user.username }, JWT_SECRET, { expiresIn: "7d" });
}

async function findUserById(id) {
  const [rows] = await pool.execute("SELECT id, username, partner_id, max_level, total_hearts FROM users WHERE id = ?", [id]);
  return rows[0] || null;
}

async function getSaveRows(userId) {
  const [rows] = await pool.execute("SELECT level_id, status FROM saves WHERE user_id = ? ORDER BY level_id", [userId]);
  return rows;
}

// ----------- API 路由 -----------
app.post("/api/register", async (req, res) => {
  const { username, password } = req.body;
  if (!username || password.length < 6) return httpError(res, 400, "密码至少6位");
  try {
    const hash = await bcrypt.hash(password, 10);
    const conn = await pool.getConnection();
    await conn.beginTransaction();
    const [result] = await conn.execute("INSERT INTO users (username, password) VALUES (?, ?)", [username, hash]);
    const userId = result.insertId;
    // 初始化 4 个关卡存档 (默认锁定)
    for (let level = 1; level <= 4; level++) {
      await conn.execute("INSERT INTO saves (user_id, level_id, status) VALUES (?, ?, ?)", [userId, level, level === 1 ? 'unlocked' : 'locked']);
    }
    await conn.commit();
    conn.release();
    res.json({ ok: true, token: signToken({ id: userId, username }), user: { id: userId, username } });
  } catch (err) {
    if (err.code === "ER_DUP_ENTRY") return httpError(res, 409, "该昵称已被注册");
    httpError(res, 500, "注册失败");
  }
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  const [rows] = await pool.execute("SELECT * FROM users WHERE username = ?", [username]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password))) return httpError(res, 401, "昵称或密码错误");
  res.json({ ok: true, token: signToken(user), user: { id: user.id, username: user.username }, saves: await getSaveRows(user.id) });
});

// ----------- Socket 鉴权 -----------
io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error("请先登录"));
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await findUserById(decoded.sub);
    socketUser.set(socket.id, user);
    next();
  } catch { next(new Error("登录状态失效")); }
});

// ----------- 游戏核心逻辑 -----------
io.on("connection", socket => {
  const user = socketUser.get(socket.id);

  const emitRoom = (room) => {
    io.to(room.code).emit("room-state", { 
      code: room.code, started: room.started, level: room.level,
      players: room.players.map(p => ({ id: p.id, username: p.username, role: p.role })) 
    });
  };

  socket.on("create-room", () => {
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    const room = { code, players: [{ id: user.id, username: user.username, socketId: socket.id, role: "A" }], started: false, level: 0 };
    rooms.set(code, room);
    socket.join(code);
    socket.emit("room-created", { code });
    emitRoom(room);
  });

  socket.on("join-room", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit("action-error", "房间不存在");
    if (room.players.length >= 2) return socket.emit("action-error", "房间已满");
    room.players.push({ id: user.id, username: user.username, socketId: socket.id, role: "B" });
    socket.join(code);
    emitRoom(room);
  });

  // 核心：接收前端的选关请求
  socket.on("start-game", ({ level }) => {
    const room = Array.from(rooms.values()).find(r => r.players.some(p => p.socketId === socket.id));
    if (!room || room.players.length !== 2) return;
    
    room.started = true;
    room.level = Number(level) || 1;
    
    // 更新数据库记录（如果通过关卡，后面 winLevel 时再更新 max_level）
    
    io.to(room.code).emit("game-started", { level: room.level });
    emitRoom(room);
    socket.emit("action-success", `已进入第 ${room.level} 关！`);
  });

  // 处理玩家操作、判定胜负（这里以简单示例为主，需要的话把之前的迷宫/推箱子逻辑补回来）
  socket.on("player-action", (data) => {
     const room = Array.from(rooms.values()).find(r => r.players.some(p => p.socketId === socket.id));
     if (!room || !room.started) return;
     
     // 广播动作给另一个人
     socket.to(room.code).emit("partner-action", { userId: user.id, data });
  });

  socket.on("disconnect", () => {
    socketUser.delete(socket.id);
    const room = Array.from(rooms.values()).find(r => r.players.some(p => p.socketId === socket.id));
    if (room) {
      room.players = room.players.filter(p => p.socketId !== socket.id);
      if (room.players.length === 0) rooms.delete(room.code);
      else emitRoom(room);
    }
  });
});

server.listen(PORT, () => console.log(`Server running on ${PORT}`));
