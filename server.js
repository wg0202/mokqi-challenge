const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const mysql = require("mysql2/promise");
const { Server } = require("socket.io");

const PORT = process.env.PORT || 80;
const JWT_SECRET = process.env.JWT_SECRET;
const DB_HOST = process.env.DB_HOST;
const DB_USER = process.env.DB_USER;
const DB_PASS = process.env.DB_PASS;
const DB_NAME = process.env.DB_NAME;
const DB_PORT = Number(process.env.DB_PORT || 3306);

const required = { DB_HOST, DB_USER, DB_PASS, DB_NAME, JWT_SECRET };
const missing = Object.entries(required).filter(([, value]) => !value).map(([key]) => key);
if (missing.length) {
  console.error("缺少必需环境变量：" + missing.join(", "));
  console.error("请在云托管环境变量中配置 DB_HOST、DB_USER、DB_PASS、DB_NAME、JWT_SECRET。");
  process.exit(1);
}

const pool = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASS,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_SIZE || 10),
  queueLimit: 0,
  charset: "utf8mb4",
  enableKeepAlive: true
});

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || true, credentials: true }
});

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
  const [rows] = await pool.execute(
    "SELECT id, username, partner_id, max_level, total_hearts FROM users WHERE id = ?",
    [id]
  );
  return rows[0] || null;
}

async function authenticateRequest(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) return httpError(res, 401, "请先登录");
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await findUserById(decoded.sub);
    if (!user) return httpError(res, 401, "账号不存在，请重新登录");
    req.user = user;
    next();
  } catch {
    return httpError(res, 401, "登录已过期，请重新登录");
  }
}

function safeProfile(user) {
  return {
    id: user.id,
    username: user.username,
    partner_id: user.partner_id,
    max_level: Number(user.max_level || 0),
    total_hearts: Number(user.total_hearts || 0)
  };
}

async function getSaveRows(userId) {
  const [rows] = await pool.execute(
    "SELECT level_id, status FROM saves WHERE user_id = ? ORDER BY level_id",
    [userId]
  );
  return rows;
}

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, database: "connected" });
  } catch (err) {
    console.error("Health check DB error:", err.message);
    res.status(503).json({ ok: false, database: "unavailable" });
  }
});

app.post("/api/register", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");

  if (!/^[\p{L}\p{N}_-]{2,32}$/u.test(username)) {
    return httpError(res, 400, "昵称需为 2–32 个字母、汉字、数字、下划线或短横线");
  }
  if (password.length < 8 || password.length > 72) {
    return httpError(res, 400, "密码长度需要为 8–72 个字符");
  }

  try {
    const hash = await bcrypt.hash(password, 12);
    const conn = await pool.getConnection();
    let userId;
    try {
      await conn.beginTransaction();
      const [result] = await conn.execute(
        "INSERT INTO users (username, password) VALUES (?, ?)",
        [username, hash]
      );
      userId = result.insertId;
      for (let level = 1; level <= LEVELS; level++) {
        await conn.execute(
          "INSERT INTO saves (user_id, level_id, status) VALUES (?, ?, ?)",
          [userId, level, level === 1 ? "unlocked" : "locked"]
        );
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      if (err.code === "ER_DUP_ENTRY") return httpError(res, 409, "这个昵称已经被注册了");
      throw err;
    } finally {
      conn.release();
    }

    const user = await findUserById(userId);
    res.status(201).json({
      ok: true,
      token: signToken(user),
      user: safeProfile(user),
      saves: await getSaveRows(userId)
    });
  } catch (err) {
    console.error("Register error:", err);
    if (!res.headersSent) httpError(res, 500, "注册失败，请稍后重试");
  }
});

app.post("/api/login", async (req, res) => {
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!username || !password) return httpError(res, 400, "请输入昵称和密码");

  try {
    const [rows] = await pool.execute("SELECT * FROM users WHERE username = ?", [username]);
    const userWithPassword = rows[0];
    if (!userWithPassword || !(await bcrypt.compare(password, userWithPassword.password))) {
      return httpError(res, 401, "昵称或密码不正确");
    }
    const user = await findUserById(userWithPassword.id);
    res.json({
      ok: true,
      token: signToken(user),
      user: safeProfile(user),
      saves: await getSaveRows(user.id)
    });
  } catch (err) {
    console.error("Login error:", err);
    httpError(res, 500, "登录失败，请稍后重试");
  }
});

app.get("/api/me", authenticateRequest, async (req, res) => {
  try {
    res.json({ ok: true, user: safeProfile(req.user), saves: await getSaveRows(req.user.id) });
  } catch (err) {
    console.error("Profile error:", err);
    httpError(res, 500, "读取存档失败");
  }
});

app.get("/api/users/search", authenticateRequest, async (req, res) => {
  const username = String(req.query.username || "").trim();
  if (username.length < 2) return httpError(res, 400, "请输入至少 2 个字符的用户名");
  try {
    const [rows] = await pool.execute(
      "SELECT id, username FROM users WHERE username = ? AND id <> ? LIMIT 1",
      [username, req.user.id]
    );
    if (!rows.length) return httpError(res, 404, "没有找到这个用户");
    res.json({ ok: true, user: rows[0] });
  } catch (err) {
    console.error("User search error:", err);
    httpError(res, 500, "查找用户失败");
  }
});

async function pairUsers(userA, userB) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[a]] = await conn.execute("SELECT id, partner_id FROM users WHERE id = ? FOR UPDATE", [userA]);
    const [[b]] = await conn.execute("SELECT id, partner_id FROM users WHERE id = ? FOR UPDATE", [userB]);
    if (!a || !b) throw new Error("用户不存在");
    if ((a.partner_id && Number(a.partner_id) !== Number(userB)) ||
        (b.partner_id && Number(b.partner_id) !== Number(userA))) {
      throw new Error("其中一位玩家已经绑定了另一位搭档");
    }
    await conn.execute("UPDATE users SET partner_id = ? WHERE id = ?", [userB, userA]);
    await conn.execute("UPDATE users SET partner_id = ? WHERE id = ?", [userA, userB]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

function makeRoomCode() {
  return crypto.randomInt(100000, 1000000).toString();
}

function getRoomForSocket(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

function playerInRoom(room, userId) {
  return room.players.find(p => Number(p.user.id) === Number(userId));
}

function publicRoom(room) {
  const maze = room.maze;
  return {
    code: room.code,
    players: room.players.map(p => ({
      id: p.user.id,
      username: p.user.username,
      role: p.role,
      connected: p.connected
    })),
    started: room.started,
    level: room.level,
    phase: room.phase,
    message: room.message,
    hearts: room.hearts,
    deadline: room.deadline,
    targetDirection: room.targetDirection,
    maze: maze ? { ...maze } : null,
    tug: room.tug ? { ...room.tug, releaseTimes: undefined, held: undefined } : null,
    box: room.box ? { ...room.box } : null,
    finish: room.phase === "finished"
  };
}

function emitRoom(room) {
  io.to(room.code).emit("room-state", publicRoom(room));
}

function makeBaseRoom(code) {
  return {
    code, players: [], started: false, level: 0, phase: "lobby",
    message: "等待两位玩家准备好 💕", hearts: 0, deadline: null,
    roundTimer: null, startTimer: null, actionTimes: {}, targetDirection: null,
    maze: null, tug: null, box: null, completed: new Set()
  };
}

function stopRoomTimers(room) {
  if (room.roundTimer) clearTimeout(room.roundTimer);
  if (room.startTimer) clearTimeout(room.startTimer);
  room.roundTimer = null;
  room.startTimer = null;
}

function emitPrivateStatus(room) {
  for (const p of room.players) {
    const socket = io.sockets.sockets.get(p.socketId);
    if (socket) socket.emit("my-role", { role: p.role, code: room.code });
  }
}

async function persistLevel(room) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    for (const p of room.players) {
      const userId = p.user.id;
      await conn.execute(
        `INSERT INTO saves (user_id, level_id, status)
         VALUES (?, ?, 'completed')
         ON DUPLICATE KEY UPDATE status = 'completed'`,
        [userId, room.level]
      );
      await conn.execute(
        "UPDATE users SET max_level = GREATEST(max_level, ?), total_hearts = total_hearts + ? WHERE id = ?",
        [room.level, HEARTS_PER_LEVEL[room.level], userId]
      );
      if (room.level < LEVELS) {
        await conn.execute(
          `INSERT INTO saves (user_id, level_id, status)
           VALUES (?, ?, 'unlocked')
           ON DUPLICATE KEY UPDATE
             status = IF(status = 'completed', status, 'unlocked')`,
          [userId, room.level + 1]
        );
      }
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function winLevel(room, message) {
  if (!room.started || room.phase === "saving" || room.phase === "finished") return;
  stopRoomTimers(room);
  room.phase = "saving";
  room.message = "合作成功！正在保存你们的进度……";
  emitRoom(room);
  try {
    await persistLevel(room);
    room.hearts += HEARTS_PER_LEVEL[room.level];
    room.phase = "result";
    room.message = message || `第 ${room.level} 关通过！共同获得 ${HEARTS_PER_LEVEL[room.level]} 点爱心 💗`;
    emitRoom(room);
    if (room.level === LEVELS) {
      room.phase = "finished";
      room.message = "四关全部通关！你们是最佳拍档！💖";
      emitRoom(room);
    } else {
      room.startTimer = setTimeout(() => {
        if (!rooms.has(room.code) || !room.started) return;
        room.level += 1;
        beginLevel(room);
      }, 1800);
    }
  } catch (err) {
    console.error("Persist progress error:", err);
    room.phase = "error";
    room.message = "保存进度失败，请检查数据库连接后重新开始。";
    emitRoom(room);
  }
}

function failLevel(room, message) {
  if (!room.started || room.phase === "result" || room.phase === "saving" || room.phase === "finished") return;
  stopRoomTimers(room);
  room.phase = "result";
  room.message = message || "差一点点！再试一次吧 💞";
  emitRoom(room);
  room.startTimer = setTimeout(() => {
    if (rooms.has(room.code) && room.started) beginLevel(room);
  }, 1700);
}

function startTimeout(room) {
  if (room.roundTimer) clearTimeout(room.roundTimer);
  room.deadline = Date.now() + 30000;
  room.roundTimer = setTimeout(() => failLevel(room, "时间到啦！准备再试一次 💗"), 30000);
}

function beginLevel(room) {
  stopRoomTimers(room);
  room.actionTimes = {};
  room.targetDirection = null;
  room.maze = null;
  room.tug = null;
  room.box = null;
  room.phase = "playing";
  room.message = `第 ${room.level} 关开始！两个人一起配合吧！`;
  if (room.level === 1) {
    room.targetDirection = ["left", "right", "up", "down"][crypto.randomInt(4)];
    room.message = "双人划船：两人请在 500 毫秒内向同一方向滑动。";
  } else if (room.level === 2) {
    room.tug = { phase: "countdown", held: {}, releaseTimes: {}, goAt: Date.now() + 3000 };
    room.message = "双人拔河：倒计时结束后同时松手！";
    room.startTimer = setTimeout(() => {
      if (!room.started || room.level !== 2 || !room.tug) return;
      room.tug.phase = "release";
      room.tug.goAt = Date.now();
      room.message = "松手！现在同时松开屏幕！";
      emitRoom(room);
      room.startTimer = setTimeout(() => failLevel(room, "没有同时松手，再来一次！"), 5000);
    }, 3000);
  } else if (room.level === 3) {
    room.maze = {
      size: 9, x: 0, y: 0, goal: { x: 8, y: 8 },
      traps: [
        "2,0", "2,1", "2,2", "4,2", "5,2", "6,2",
        "6,3", "1,4", "2,4", "3,4", "5,5", "5,6",
        "7,6", "7,7"
      ],
      walls: []
    };
    room.message = "双人迷宫：A 负责上下，B 负责左右，躲开黑洞到达终点。";
  } else if (room.level === 4) {
    room.box = {
      size: 7, player: { x: 1, y: 1 }, crate: { x: 2, y: 1 },
      goal: { x: 5, y: 5 },
      walls: [
        "0,3", "1,3", "2,3", "4,1", "4,2", "4,3",
        "2,5", "3,5", "1,6", "5,2"
      ]
    };
    room.message = "双人推箱子：A 控制上下，B 控制左右，把礼物推到爱心目标。";
  }
  startTimeout(room);
  emitRoom(room);
  emitPrivateStatus(room);
}

async function tryPairWithUsername(socket, targetUsername) {
  const me = socketUser.get(socket.id);
  if (!me) return socket.emit("action-error", "请先登录后再组队");
  const username = String(targetUsername || "").trim();
  if (!username || username === me.username) return socket.emit("action-error", "请输入另一位玩家的用户名");
  const [rows] = await pool.execute("SELECT id, username, partner_id FROM users WHERE username = ? LIMIT 1", [username]);
  if (!rows.length) return socket.emit("action-error", "没有找到这个用户名");
  try {
    await pairUsers(me.id, rows[0].id);
    socket.emit("action-success", "搭档绑定成功！请让对方登录并加入房间。");
  } catch (err) {
    socket.emit("action-error", err.message || "绑定搭档失败");
  }
}

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("请先登录"));
    const decoded = jwt.verify(token, JWT_SECRET);
    const user = await findUserById(decoded.sub);
    if (!user) return next(new Error("账号不存在"));
    socketUser.set(socket.id, safeProfile(user));
    socket.data.userId = user.id;
    next();
  } catch {
    next(new Error("登录已过期，请重新登录"));
  }
});

io.on("connection", socket => {
  socket.emit("socket-ready", { ok: true });

  socket.on("pair-username", async payload => {
    try {
      await tryPairWithUsername(socket, payload?.username);
    } catch (err) {
      console.error("Pair username error:", err);
      socket.emit("action-error", "组队请求失败，请稍后重试");
    }
  });

  socket.on("create-room", async () => {
    const user = socketUser.get(socket.id);
    if (!user) return socket.emit("action-error", "请重新登录");
    let code;
    do { code = makeRoomCode(); } while (rooms.has(code));
    const room = makeBaseRoom(code);
    room.players.push({ user, socketId: socket.id, role: "A", connected: true });
    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;
    socket.emit("room-created", { code });
    emitRoom(room);
    emitPrivateStatus(room);
  });

  socket.on("join-room", async payload => {
    const code = String(payload?.code || "").trim();
    const room = rooms.get(code);
    const user = socketUser.get(socket.id);
    if (!room) return socket.emit("action-error", "房间不存在或已关闭");
    if (!user) return socket.emit("action-error", "请重新登录");
    if (room.players.some(p => Number(p.user.id) === Number(user.id))) {
      return socket.emit("action-error", "同一个账号不能同时占据两个玩家位置");
    }
    if (room.players.length >= 2 || room.started) return socket.emit("action-error", "房间已满或游戏已开始");
    room.players.push({ user, socketId: socket.id, role: "B", connected: true });
    socket.join(code);
    socket.data.roomCode = code;
    try {
      await pairUsers(room.players[0].user.id, room.players[1].user.id);
      room.message = "两位玩家到齐啦！点击开始游戏吧 💗";
      emitRoom(room);
      emitPrivateStatus(room);
    } catch (err) {
      room.players = room.players.filter(p => p.socketId !== socket.id);
      socket.leave(code);
      delete socket.data.roomCode;
      socket.emit("action-error", err.message || "绑定搭档失败");
      emitRoom(room);
    }
  });

  socket.on("start-game", () => {
    const room = getRoomForSocket(socket);
    if (!room || room.players.length !== 2 || room.started) return;
    if (room.players.some(p => !p.connected)) return socket.emit("action-error", "请等待两位玩家都在线");
    room.started = true;
    room.level = 1;
    room.hearts = 0;
    beginLevel(room);
  });

  socket.on("row-swipe", payload => {
    const room = getRoomForSocket(socket);
    if (!room || !room.started || room.level !== 1 || room.phase !== "playing") return;
    const player = playerInRoom(room, socket.data.userId);
    const direction = String(payload?.direction || "");
    if (!player || !["up", "down", "left", "right"].includes(direction)) return;
    if (room.actionTimes[player.role]) return;
    room.actionTimes[player.role] = { direction, time: Date.now() };
    const a = room.actionTimes.A, b = room.actionTimes.B;
    if (a && b) {
      if (Math.abs(a.time - b.time) <= 500 && a.direction === b.direction) {
        winLevel(room, "双人划船成功！同心协力 +10 爱心 🚣");
      } else {
        failLevel(room, "划船方向或时机不一致，再试一次！");
      }
    } else {
      room.message = "收到一位玩家的划船动作，等待搭档……";
      emitRoom(room);
    }
  });

  socket.on("tug-hold", payload => {
    const room = getRoomForSocket(socket);
    if (!room || !room.started || room.level !== 2 || room.phase !== "playing" || !room.tug) return;
    const player = playerInRoom(room, socket.data.userId);
    if (!player || room.tug.phase !== "countdown") return;
    room.tug.held[player.role] = Boolean(payload?.held);
    if (room.tug.held.A && room.tug.held.B) {
      room.message = "两个人都按住啦！等待“松手”提示……";
      emitRoom(room);
    } else {
      emitRoom(room);
    }
  });

  socket.on("tug-release", () => {
    const room = getRoomForSocket(socket);
    if (!room || !room.started || room.level !== 2 || room.phase !== "playing" || !room.tug) return;
    const player = playerInRoom(room, socket.data.userId);
    if (!player || room.tug.phase !== "release" || !room.tug.held[player.role]) return;
    if (room.tug.releaseTimes[player.role]) return;
    room.tug.releaseTimes[player.role] = Date.now();
    const a = room.tug.releaseTimes.A, b = room.tug.releaseTimes.B;
    if (a && b) {
      if (Math.abs(a - b) <= 500 && room.tug.held.A && room.tug.held.B) {
        winLevel(room, "双人拔河成功！完美同步 +15 爱心 🪢");
      } else {
        failLevel(room, "松手时机差了一点，再试一次！");
      }
    } else {
      room.message = "收到一位玩家的松手动作，等待搭档……";
      emitRoom(room);
    }
  });

  socket.on("maze-move", payload => {
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
    if (maze.traps.includes(`${nx},${ny}`)) {
      failLevel(room, "哎呀，掉进黑洞啦！再试一次吧 🕳️");
      return;
    }
    maze.x = nx;
    maze.y = ny;
    if (nx === maze.goal.x && ny === maze.goal.y) {
      winLevel(room, "双人迷宫通关！配合满分 +20 爱心 🏁");
    } else {
      room.message = `${player.role} 玩家移动成功，继续合作寻找终点！`;
      emitRoom(room);
    }
  });

  socket.on("box-move", payload => {
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
    if (blocked(px, py)) {
      room.message = "前面是墙壁，换个方向试试！🧱";
      emitRoom(room);
      return;
    }
    if (px === box.crate.x && py === box.crate.y) {
      const cx = box.crate.x + delta[0], cy = box.crate.y + delta[1];
      if (blocked(cx, cy)) {
        room.message = "礼物被墙挡住啦，换个方向推！🎁";
        emitRoom(room);
        return;
      }
      box.crate = { x: cx, y: cy };
    }
    box.player = { x: px, y: py };
    if (box.crate.x === box.goal.x && box.crate.y === box.goal.y) {
      winLevel(room, "礼物成功送到爱心位置！推箱子通关 +25 爱心 🎁");
    } else {
      room.message = "继续合作，把礼物推到爱心上！";
      emitRoom(room);
    }
  });

  socket.on("disconnect", () => {
    const user = socketUser.get(socket.id);
    socketUser.delete(socket.id);
    const room = getRoomForSocket(socket);
    if (!room) return;
    const player = room.players.find(p => p.socketId === socket.id);
    if (player) player.connected = false;
    stopRoomTimers(room);
    room.started = false;
    room.phase = "lobby";
    room.deadline = null;
    room.message = "有玩家断开连接。请刷新页面并重新创建或加入房间。";
    emitRoom(room);
    if (room.players.every(p => !p.connected)) rooms.delete(room.code);
    if (user) console.log(`User ${user.username} disconnected`);
  });
});

async function start() {
  try {
    await pool.query("SELECT 1");
    console.log("MySQL 连接成功");
    server.listen(PORT, "0.0.0.0", () => {
      console.log(`游戏服务器正在监听端口 ${PORT}`);
    });
  } catch (err) {
    console.error("无法连接 MySQL，请检查 DB_HOST/DB_USER/DB_PASS/DB_NAME：", err.message);
    process.exit(1);
  }
}

start();
