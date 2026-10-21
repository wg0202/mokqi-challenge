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

const required = { DB_HOST, DB_USER, DB_PASS, DB_NAME, JWT_SECRET };
const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
if (missing.length) {
  console.error("缺少必需环境变量：" + missing.join(", "));
  process.exit(1);
}

const pool = mysql.createPool({
  host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS, database: DB_NAME,
  waitForConnections: true, connectionLimit: 10, queueLimit: 0, charset: "utf8mb4"
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.CORS_ORIGIN || true, credentials: true } });

app.use(express.json({ limit: "32kb" }));
app.use(express.static(path.join(__dirname, "public")));

const LEVELS = 4;
const HEARTS_PER_LEVEL = [0, 10, 15, 20, 25];
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
    for (let level = 1; level <= LEVELS; level++) {
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
    socket.data.userId = user.id;
    next();
  } catch { next(new Error("登录状态失效")); }
});

// ----------- 游戏核心逻辑 -----------
io.on("connection", socket => {
  const user = socketUser.get(socket.id);

  const getRoomForSocket = (socket) => {
    const code = socket.data.roomCode;
    return code ? rooms.get(code) : null;
  };

  const playerInRoom = (room, userId) => {
    return room.players.find(p => Number(p.user.id) === Number(userId));
  };

  const emitRoom = (room) => {
    io.to(room.code).emit("room-state", { 
      code: room.code, started: room.started, level: room.level, hearts: room.hearts, phase: room.phase,
      message: room.message, deadline: room.deadline, targetDirection: room.targetDirection,
      maze: room.maze ? { ...room.maze } : null,
      tug: room.tug ? { ...room.tug, releaseTimes: undefined, held: undefined } : null,
      box: room.box ? { ...room.box } : null,
      players: room.players.map(p => ({ id: p.user.id, username: p.user.username, role: p.role, connected: p.connected })) 
    });
  };

  const stopRoomTimers = (room) => {
    if (room.roundTimer) clearTimeout(room.roundTimer);
    if (room.startTimer) clearTimeout(room.startTimer);
    room.roundTimer = null;
    room.startTimer = null;
  };

  // 核心：保存进度到数据库
  const persistLevel = async (room) => {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      for (const p of room.players) {
        const userId = p.user.id;
        await conn.execute(`INSERT INTO saves (user_id, level_id, status) VALUES (?, ?, 'completed') ON DUPLICATE KEY UPDATE status = 'completed'`, [userId, room.level]);
        await conn.execute(`UPDATE users SET max_level = GREATEST(max_level, ?), total_hearts = total_hearts + ? WHERE id = ?`, [room.level, HEARTS_PER_LEVEL[room.level], userId]);
        if (room.level < LEVELS) {
          await conn.execute(`INSERT INTO saves (user_id, level_id, status) VALUES (?, ?, 'unlocked') ON DUPLICATE KEY UPDATE status = IF(status = 'completed', status, 'unlocked')`, [userId, room.level + 1]);
        }
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  };

  const winLevel = async (room, message) => {
    if (!room.started || room.phase === "saving" || room.phase === "finished") return;
    stopRoomTimers(room);
    room.phase = "saving";
    room.message = "合作成功！正在保存进度……";
    emitRoom(room);
    try {
      await persistLevel(room);
      room.hearts += HEARTS_PER_LEVEL[room.level];
      room.phase = "result";
      room.message = message || `第 ${room.level} 关通过！共同获得 ${HEARTS_PER_LEVEL[room.level]} 点爱心 💗`;
      emitRoom(room);
      if (room.level === LEVELS) {
        room.phase = "finished"; room.message = "全部通关！你们是最佳拍档！💖"; emitRoom(room);
      } else {
        room.startTimer = setTimeout(() => {
          if (!rooms.has(room.code) || !room.started) return;
          room.level += 1; beginLevel(room);
        }, 1800);
      }
    } catch (err) {
      room.phase = "error"; room.message = "保存进度失败"; emitRoom(room);
    }
  };

  const failLevel = (room, message) => {
    if (!room.started || room.phase === "result" || room.phase === "saving" || room.phase === "finished") return;
    stopRoomTimers(room);
    room.phase = "result"; room.message = message || "差一点点！再试一次吧 💞";
    emitRoom(room);
    room.startTimer = setTimeout(() => {
      if (rooms.has(room.code) && room.started) beginLevel(room);
    }, 1700);
  };

  const beginLevel = (room) => {
    stopRoomTimers(room);
    room.actionTimes = {}; room.targetDirection = null; room.maze = null; room.tug = null; room.box = null; room.phase = "playing";
    
    if (room.level === 1) {
      room.targetDirection = ["left", "right", "up", "down"][crypto.randomInt(4)];
      room.message = "双人划船：两人请在 500 毫秒内向同一方向滑动。";
    } else if (room.level === 2) {
      room.tug = { phase: "countdown", held: {}, releaseTimes: {}, goAt: Date.now() + 3000 };
      room.message = "双人拔河：倒计时结束后同时松手！";
      room.startTimer = setTimeout(() => {
        if (!room.started || room.level !== 2 || !room.tug) return;
        room.tug.phase = "release"; room.tug.goAt = Date.now(); room.message = "松手！现在同时松开屏幕！"; emitRoom(room);
        room.startTimer = setTimeout(() => failLevel(room, "没有同时松手，再来一次！"), 5000);
      }, 3000);
    } else if (room.level === 3) {
      room.maze = { size: 9, x: 0, y: 0, goal: { x: 8, y: 8 }, traps: ["2,0", "2,1", "2,2", "4,2", "5,2", "6,2", "6,3", "1,4", "2,4", "3,4", "5,5", "5,6", "7,6", "7,7"], walls: [] };
      room.message = "双人迷宫：A 负责上下，B 负责左右，躲开黑洞到达终点。";
    } else if (room.level === 4) {
      room.box = { size: 7, player: { x: 1, y: 1 }, crate: { x: 2, y: 1 }, goal: { x: 5, y: 5 }, walls: ["0,3", "1,3", "2,3", "4,1", "4,2", "4,3", "2,5", "3,5", "1,6", "5,2"] };
      room.message = "双人推箱子：A 控制上下，B 控制左右，把礼物推到爱心目标。";
    }
    room.deadline = Date.now() + 30000;
    room.roundTimer = setTimeout(() => failLevel(room, "时间到啦！准备再试一次 💗"), 30000);
    emitRoom(room);
  };

  socket.on("create-room", () => {
    let code; do { code = Math.floor(100000 + Math.random() * 900000).toString(); } while (rooms.has(code));
    const room = { code, players: [{ user, socketId: socket.id, role: "A", connected: true }], started: false, level: 1, hearts: 0, phase: "lobby" };
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit("room-created", { code });
    emitRoom(room);
  });

  socket.on("join-room", ({ code }) => {
    const room = rooms.get(code);
    if (!room) return socket.emit("action-error", "房间不存在");
    if (room.players.length >= 2) return socket.emit("action-error", "房间已满");
    room.players.push({ user, socketId: socket.id, role: "B", connected: true });
    socket.join(code);
    socket.data.roomCode = code;
    room.message = "两人已到齐，请房主选择关卡开始！";
    emitRoom(room);
  });

  // 接收前端选关请求
  socket.on("start-game", ({ level }) => {
    const room = getRoomForSocket(socket);
    if (!room || room.players.length !== 2 || room.started) return;
    room.started = true; room.hearts = 0; room.level = Number(level) || 1;
    beginLevel(room);
  });

  // ====== 游戏具体操作逻辑 ======
  socket.on("row-swipe", (payload) => {
    const room = getRoomForSocket(socket);
    if (!room || !room.started || room.level !== 1 || room.phase !== "playing") return;
    const player = playerInRoom(room, socket.data.userId);
    const direction = String(payload?.direction || "");
    if (!player || room.actionTimes[player.role]) return;
    room.actionTimes[player.role] = { direction, time: Date.now() };
    const a = room.actionTimes.A, b = room.actionTimes.B;
    if (a && b) {
      if (Math.abs(a.time - b.time) <= 500 && a.direction === b.direction) winLevel(room, "双人划船成功！🚣");
      else failLevel(room, "划船方向或时机不一致！");
    } else emitRoom(room);
  });

  socket.on("tug-hold", (payload) => {
    const room = getRoomForSocket(socket);
    if (!room || !room.started || room.level !== 2 || room.phase !== "playing" || !room.tug) return;
    const player = playerInRoom(room, socket.data.userId);
    if (!player || room.tug.phase !== "countdown") return;
    room.tug.held[player.role] = Boolean(payload?.held);
    emitRoom(room);
  });

  socket.on("tug-release", () => {
    const room = getRoomForSocket(socket);
    if (!room || !room.started || room.level !== 2 || room.phase !== "playing" || !room.tug) return;
    const player = playerInRoom(room, socket.data.userId);
    if (!player || room.tug.phase !== "release" || !room.tug.held[player.role] || room.tug.releaseTimes[player.role]) return;
    room.tug.releaseTimes[player.role] = Date.now();
    const a = room.tug.releaseTimes.A, b = room.tug.releaseTimes.B;
    if (a && b) {
      if (Math.abs(a - b) <= 500) winLevel(room, "双人拔河成功！🪢");
      else failLevel(room, "松手时机差了一点！");
    } else emitRoom(room);
  });

  socket.on("maze-move", (payload) => {
    const room = getRoomForSocket(socket);
    if (!room || !room.started || room.level !== 3 || room.phase !== "playing" || !room.maze) return;
    const player = playerInRoom(room, socket.data.userId);
    const direction = String(payload?.direction || "");
    if (!player) return;
    const allowed = player.role === "A" ? ["up", "down"] : ["left", "right"];
    if (!allowed.includes(direction)) return socket.emit("action-error", "这个方向由你的搭档控制");
    const maze = room.maze;
    const delta = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[direction];
    const nx = maze.x + delta[0], ny = maze.y + delta[1];
    if (nx < 0 || ny < 0 || nx >= maze.size || ny >= maze.size) return;
    if (maze.traps.includes(`${nx},${ny}`)) return failLevel(room, "掉进黑洞啦！");
    maze.x = nx; maze.y = ny;
    if (nx === maze.goal.x && ny === maze.goal.y) winLevel(room, "迷宫通关！🏁");
    else emitRoom(room);
  });

  socket.on("box-move", (payload) => {
    const room = getRoomForSocket(socket);
    if (!room || !room.started || room.level !== 4 || room.phase !== "playing" || !room.box) return;
    const player = playerInRoom(room, socket.data.userId);
    const direction = String(payload?.direction || "");
    if (!player) return;
    const allowed = player.role === "A" ? ["up", "down"] : ["left", "right"];
    if (!allowed.includes(direction)) return socket.emit("action-error", "这个方向由你的搭档控制");
    const box = room.box;
    const delta = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[direction];
    const px = box.player.x + delta[0], py = box.player.y + delta[1];
    const blocked = (x, y) => x < 0 || y < 0 || x >= box.size || y >= box.size || box.walls.includes(`${x},${y}`);
    if (blocked(px, py)) return emitRoom(room);
    if (px === box.crate.x && py === box.crate.y) {
      const cx = box.crate.x + delta[0], cy = box.crate.y + delta[1];
      if (blocked(cx, cy)) return emitRoom(room);
      box.crate = { x: cx, y: cy };
    }
    box.player = { x: px, y: py };
    if (box.crate.x === box.goal.x && box.crate.y === box.goal.y) winLevel(room, "推箱子通关！🎁");
    else emitRoom(room);
  });

  socket.on("disconnect", () => {
    socketUser.delete(socket.id);
    const room = getRoomForSocket(socket);
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (player) player.connected = false;
    stopRoomTimers(room); room.started = false; room.phase = "lobby";
    room.message = "有玩家断开连接，请刷新页面重新建房。";
    emitRoom(room);
    if (room.players.every(p => !p.connected)) rooms.delete(room.code);
  });
});

server.listen(PORT, () => console.log(`Server running on ${PORT}`));
