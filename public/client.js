const socket = io({ autoConnect: false }); // 初始不连接
const $ = id => document.getElementById(id);

let currentToken = "";

function toast(msg) {
  const el = $("notice");
  el.textContent = msg;
  el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2500);
}

// 注册
$("btn-register").onclick = async () => {
  const username = $("username").value.trim();
  const password = $("password").value.trim();
  if (!username || !password) return toast("请输入账号密码");

  const res = await fetch("/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  if (data.ok) {
    toast("注册成功，请登录！");
  } else {
    toast(data.message);
  }
};

// 登录
$("btn-login").onclick = async () => {
  const username = $("username").value.trim();
  const password = $("password").value.trim();
  if (!username || !password) return toast("请输入账号密码");

  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const data = await res.json();
  
  if (data.ok) {
    currentToken = data.token;
    $("auth-screen").classList.add("hidden");
    $("lobby-screen").classList.remove("hidden");
    $("my-name").textContent = data.user.username;
    
    // 登录成功后，带上 Token 连接 WebSocket
    socket.auth = { token: currentToken };
    socket.connect();
  } else {
    toast(data.message);
  }
};

// 创建房间
$("create-room-btn").onclick = () => {
  console.log("点击了创建房间"); // 用于测试，可以在F12看到
  if (!socket.connected) return toast("连接服务器中，请稍后...");
  socket.emit("create-room");
};

// 加入房间
$("join-room-btn").onclick = () => {
  const code = $("room-code-input").value.trim();
  if (code) socket.emit("join-room", { code });
};

// 选关按钮
document.querySelectorAll(".level-btn").forEach(btn => {
  btn.onclick = () => {
    const level = Number(btn.dataset.level);
    socket.emit("start-game", { level });
  };
});

// Socket 监听
socket.on("connect", () => {
  toast("连接服务器成功");
});

socket.on("connect_error", (err) => {
  toast(err.message || "连接失败");
});

socket.on("room-state", (room) => {
  // 两人到齐后显示选关按钮
  if (room.players.length === 2) {
    $("room-actions").classList.add("hidden");
    $("level-select-panel").classList.remove("hidden");
    toast("两人已到齐，请选择关卡！");
  }
});

socket.on("game-started", (data) => {
  $("lobby-screen").classList.add("hidden");
  $("game-screen").classList.remove("hidden");
  $("game-title").textContent = `正在挑战第 ${data.level} 关`;
  
  // 这里之后再把具体的划船、推箱子渲染代码贴进来
});

socket.on("action-error", (msg) => toast(msg));
socket.on("action-success", (msg) => toast(msg));
