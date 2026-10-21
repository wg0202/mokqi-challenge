const socket = io({ autoConnect: false });
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
  if (data.ok) toast("注册成功，请登录！");
  else toast(data.message);
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
    
    socket.auth = { token: currentToken };
    socket.connect(); // 登录成功再连接
  } else {
    toast(data.message);
  }
};

// 创建房间
$("create-room-btn").onclick = () => {
  console.log("点击了创建房间，正在发送请求..."); // 方便 F12 看
  if (!socket.connected) {
    toast("服务器正在连接，请稍等1秒再点...");
    return;
  }
  socket.emit("create-room");
};

// 加入房间
$("join-room-btn").onclick = () => {
  const code = $("room-code-input").value.trim();
  if (code) socket.emit("join-room", { code });
  else toast("请输入房间号");
};

// 选关
document.querySelectorAll(".level-btn").forEach(btn => {
  btn.onclick = () => {
    const level = Number(btn.dataset.level);
    socket.emit("start-game", { level });
  };
});

// 监听服务器返回
socket.on("connect", () => console.log("Socket 已连接"));
socket.on("connect_error", (err) => toast(err.message || "连接失败"));

socket.on("room-created", (data) => {
  console.log("房间创建成功，房间号:", data.code);
  toast(`房间创建成功！房间号：${data.code}`);
  // 把房间号自动填到输入框里
  if ($("room-code-input")) $("room-code-input").value = data.code;
});

socket.on("room-state", (room) => {
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
});

socket.on("action-error", (msg) => toast(msg));
socket.on("action-success", (msg) => toast(msg));
