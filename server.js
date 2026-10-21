
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const crypto = require("crypto");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 80;
const ROUND_MS = 30_000;
const HEART_DELAY_MS = 3_000;
const CLICK_WINDOW_MS = 500;

app.use(express.static(path.join(__dirname, "public")));

const rooms = new Map();

const questions = [
  {
    question: "如果周末可以一起出去玩，你最想去哪里？",
    options: ["海边看日落 🌅", "游乐园 🎡", "山里露营 ⛺", "在家抱抱 🧸"]
  },
  {
    question: "你觉得两个人最浪漫的约会是什么？",
    options: ["一起看星星 ✨", "一起做好吃的 🍰", "牵手散步 🌷", "一起看电影 🎬"]
  },
  {
    question: "如果收到对方的小惊喜，你最期待什么？",
    options: ["一封情书 💌", "一束鲜花 💐", "一顿大餐 🍓", "一个拥抱 🤗"]
  }
];

const directions = [
  { id: "up", label: "向上", emoji: "⬆️" },
  { id: "down", label: "向下", emoji: "⬇️" },
  { id: "left", label: "向左", emoji: "⬅️" },
  { id: "right", label: "向右", emoji: "➡️" }
];

function makeCode() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function getRoom(socket) {
  const code = socket.data.roomCode;
  return code ? rooms.get(code) : null;
}

function getPlayerName(room, socketId) {
  const player = room.players.find(p => p.id === socketId);
  return player ? player.name : "小伙伴";
}

function publicState(room) {
  return {
    code: room.code,
    players: room.players.map(p => ({
      name: p.name,
      connected: p.connected
    })),
    started: room.started,
    level: room.level,
    hearts: room.hearts,
    phase: room.phase,
    deadline: room.deadline,
    question: room.question,
    options: room.options,
    targetDirection: room.targetDirection,
    directions,
    heartRedAt: room.heartRedAt,
    message: room.message
  };
}

function sendState(room) {
  io.to(room.code).emit("game-state", publicState(room));
}

function clearTimers(room) {
  if (room.roundTimer) clearTimeout(room.roundTimer);
  if (room.heartTimer) clearTimeout(room.heartTimer);
  if (room.retryTimer) clearTimeout(room.retryTimer);

  room.roundTimer = null;
  room.heartTimer = null;
  room.retryTimer = null;
}

function stopRoom(room) {
  clearTimers(room);
  room.deadline = null;
}

function resetRoom(code) {
  const room = rooms.get(code);
  if (!room) return;

  stopRoom(room);
  room.started = false;
  room.level = 0;
  room.hearts = 0;
  room.phase = "waiting";
  room.answers = {};
  room.clicks = {};
  room.question = "";
  room.options = [];
  room.targetDirection = null;
  room.heartRedAt = null;
  room.message = "两个人都准备好了吗？💕";

  sendState(room);
}

function beginGame(room) {
  if (room.players.length !== 2) return;

  stopRoom(room);
  room.started = true;
  room.level = 1;
  room.hearts = 0;
  startLevel(room);
}

function startLevel(room) {
  clearTimers(room);
  room.answers = {};
  room.clicks = {};
  room.deadline = Date.now() + ROUND_MS;
  room.question = "";
  room.options = [];
  room.targetDirection = null;
  room.heartRedAt = null;

  if (room.level === 1) {
    const item = questions[crypto.randomInt(questions.length)];
    room.question = item.question;
    room.options = item.options;
    room.phase = "answering";
    room.message = "选出你们心中的同一个答案！";
  } else if (room.level === 2) {
    const item = directions[crypto.randomInt(directions.length)];
    room.targetDirection = item.id;
    room.phase = "answering";
    room.message = `默契指令：${item.emoji} ${item.label}`;
  } else if (room.level === 3) {
    room.phase = "heart-wait";
    room.message = "准备好了吗？爱心即将亮起！";
    room.heartTimer = setTimeout(() => {
      if (!room.started || room.level !== 3) return;

      room.phase = "heart-active";
      room.heartRedAt = Date.now();
      room.message = "现在！一起点击大爱心！";
      sendState(room);
    }, HEART_DELAY_MS);
  }

  room.roundTimer = setTimeout(() => {
    if (room.started && room.phase !== "result") {
      failLevel(room, "时间到啦，再试一次吧！");
    }
  }, ROUND_MS);

  sendState(room);
}

function failLevel(room, message) {
  if (!room.started || room.phase === "result") return;

  clearTimers(room);
  room.phase = "result";
  room.message = message;
  room.deadline = null;
  sendState(room);

  room.retryTimer = setTimeout(() => {
    if (!room.started || !rooms.has(room.code)) return;
    startLevel(room);
  }, 1800);
}

function completeLevel(room, points) {
  if (!room.started || room.phase === "result") return;

  clearTimers(room);
  room.hearts += points;

  if (room.level >= 3) {
    room.phase = "finished";
    room.message = "恭喜你们！你们是最有默契的情侣！💖";
    room.deadline = null;
    sendState(room);
    return;
  }

  room.phase = "result";
  room.message = `默契成功！共同获得 ${points} 点爱心！💗`;
  room.deadline = null;
  sendState(room);

  room.retryTimer = setTimeout(() => {
    if (!room.started || !rooms.has(room.code)) return;
    room.level += 1;
    startLevel(room);
  }, 1600);
}

io.on("connection", socket => {
  socket.emit("connected", { id: socket.id });

  socket.on("create-room", (payload = {}, callback) => {
    let code;
    do {
      code = makeCode();
    } while (rooms.has(code));

    const name = String(payload.name || "小可爱")
      .trim()
      .slice(0, 12) || "小可爱";

    const room = {
      code,
      players: [{ id: socket.id, name, connected: true }],
      started: false,
      level: 0,
      hearts: 0,
      phase: "waiting",
      deadline: null,
      question: "",
      options: [],
      targetDirection: null,
      heartRedAt: null,
      answers: {},
      clicks: {},
      message: "房间创建成功，邀请你的另一半加入吧！💕",
      roundTimer: null,
      heartTimer: null,
      retryTimer: null
    };

    rooms.set(code, room);
    socket.join(code);
    socket.data.roomCode = code;

    sendState(room);
    if (typeof callback === "function") callback({ ok: true, code });
  });

  socket.on("join-room", (payload = {}, callback) => {
    const code = String(payload.code || "").trim().toUpperCase();
    const room = rooms.get(code);

    const reply = data => {
      if (typeof callback === "function") callback(data);
    };

    if (!room) return reply({ ok: false, message: "没有找到这个房间，请检查房间号。" });
    if (room.players.length >= 2) {
      return reply({ ok: false, message: "房间已经满啦！" });
    }
    if (room.started) {
      return reply({ ok: false, message: "游戏已经开始，暂时不能加入。" });
    }

    const name = String(payload.name || "小甜心")
      .trim()
      .slice(0, 12) || "小甜心";

    room.players.push({ id: socket.id, name, connected: true });
    socket.join(code);
    socket.data.roomCode = code;

    room.message = "两位玩家到齐啦！准备开始甜蜜冒险！";
    sendState(room);
    reply({ ok: true, code });
  });

  socket.on("start-game", () => {
    const room = getRoom(socket);
    if (!room || room.players.length !== 2 || room.started) return;
    if (room.players.some(p => !p.connected)) return;

    beginGame(room);
  });

  socket.on("submit-answer", payload => {
    const room = getRoom(socket);
    if (!room || !room.started || room.phase !== "answering") return;
    if (Date.now() > room.deadline) return;
    if (!room.players.some(p => p.id === socket.id)) return;
    if (Object.prototype.hasOwnProperty.call(room.answers, socket.id)) return;

    const answer = String(payload && payload.answer || "");
    const allowed = room.level === 1
      ? room.options.map((_, index) => String(index))
      : directions.map(d => d.id);

    if (!allowed.includes(answer)) return;

    room.answers[socket.id] = answer;

    const submitted = Object.keys(room.answers).length;
    if (submitted < 2) {
      room.message = `${getPlayerName(room, socket.id)} 已经做好选择，等待另一半……`;
      sendState(room);
      return;
    }

    const values = Object.values(room.answers);
    if (values[0] === values[1]) {
      completeLevel(room, room.level === 1 ? 10 : 15);
    } else {
      failLevel(room, "差一点点就默契成功啦！准备重试 💞");
    }
  });

  socket.on("heart-click", () => {
    const room = getRoom(socket);
    if (!room || !room.started || room.level !== 3) return;
    if (room.phase !== "heart-active") return;
    if (!room.players.some(p => p.id === socket.id)) return;
    if (Date.now() > room.deadline) return;
    if (Object.prototype.hasOwnProperty.call(room.clicks, socket.id)) return;

    room.clicks[socket.id] = Date.now();

    if (Object.keys(room.clicks).length < 2) {
      room.message = "收到一次点击！另一半快跟上！💓";
      sendState(room);
      return;
    }

    const times = Object.values(room.clicks);
    const difference = Math.abs(times[0] - times[1]);

    if (difference <= CLICK_WINDOW_MS) {
      completeLevel(room, 20);
    } else {
      failLevel(room, "心跳差了一点点！再试一次吧 💗");
    }
  });

  socket.on("disconnect", () => {
    const room = getRoom(socket);
    if (!room) return;

    const player = room.players.find(p => p.id === socket.id);
    if (player) player.connected = false;

    if (room.started) {
      stopRoom(room);
      room.started = false;
      room.phase = "waiting";
      room.deadline = null;
      room.message = "有一位玩家掉线了，请重新连接后创建新房间再玩。";
    } else {
      room.message = "有一位玩家离开了房间。";
    }

    sendState(room);

    if (room.players.every(p => !p.connected)) {
      stopRoom(room);
      rooms.delete(room.code);
    }
  });
});

server.listen(PORT, () => {
  console.log(`情侣默契大通关已启动，端口：${PORT}`);
});
