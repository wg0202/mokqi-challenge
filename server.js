const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const crypto = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 80;
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new Map();
const rounds = ['quiz', 'rps', 'reaction', 'choice', 'random'];
const questions = [
  { q: '周末突然放假，你更想？', a: ['宅家放松', '出门探索', '睡到自然醒', '都可以'] },
  { q: '哪种超能力最实用？', a: ['瞬间移动', '时间暂停', '读懂动物', '无限美食'] },
  { q: '深夜肚子饿了，你会？', a: ['点外卖', '找零食', '忍一忍', '拉朋友一起吃'] },
  { q: '旅行时最重要的是？', a: ['美食', '风景', '同伴', '计划外的惊喜'] },
  { q: '如果中了小奖，你会？', a: ['请朋友吃饭', '存起来', '买喜欢的东西', '马上安排旅行'] }
];
const choices = [
  { q: '只能选一个：', a: ['海边发呆', '山里徒步'] },
  { q: '理想的周末：', a: ['宅家看剧', '出门玩一天'] },
  { q: '午夜小吃选谁：', a: ['炸鸡薯条', '烧烤火锅'] },
  { q: '旅行风格：', a: ['提前做攻略', '随心走走'] },
  { q: '获得礼物更喜欢：', a: ['实用惊喜', '浪漫仪式感'] }
];
const randomEvents = [
  { title: '好运加倍！', desc: '本轮得分额外 +2。', bonus: 2 },
  { title: '默契加成！', desc: '两人选了相同答案就额外 +3。', bonus: 3 },
  { title: '轻松一局', desc: '本轮只为开心，不加不扣分。', bonus: 0 },
  { title: '反应时刻', desc: '准备好了吗？下一轮拼手速！', bonus: 1 }
];
function code() { return crypto.randomBytes(3).toString('hex').toUpperCase(); }
function publicRoom(room) {
  return { code: room.code, players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, score: p.score, ready: p.ready })), started: room.started, roundIndex: room.roundIndex };
}
function emitRoom(room) { io.to(room.code).emit('room:update', publicRoom(room)); }
function getRoomFor(socket) {
  for (const r of rooms.values()) if (r.players.has(socket.id)) return r;
  return null;
}
function finishRound(room) {
  if (!room.current || room.current.finished) return;
  const entries = [...room.players.values()];
  if (entries.length < 2 || entries.some(p => !room.current.answers[p.id])) return;
  const r = room.current;
  const [p1, p2] = entries;
  const a1 = r.answers[p1.id], a2 = r.answers[p2.id];
  let result = { title: '本轮结果', detail: '', scores: {} };
  const add = (p, n) => { p.score += n; result.scores[p.id] = (result.scores[p.id] || 0) + n; };
  if (r.type === 'quiz') {
    if (a1 === a2) { add(p1, 2); add(p2, 2); result.detail = '你们选了一样的答案！双方 +2 分'; }
    else { add(p1, 1); add(p2, 1); result.detail = '答案不同也没关系，勇敢表达各 +1 分'; }
  } else if (r.type === 'rps') {
    if (a1 === a2) result.detail = '平局！再来一把也许就分胜负。';
    else if ((a1 === '石头' && a2 === '剪刀') || (a1 === '剪刀' && a2 === '布') || (a1 === '布' && a2 === '石头')) { add(p1, 3); result.detail = `${p1.name} 获胜，+3 分！`; }
    else { add(p2, 3); result.detail = `${p2.name} 获胜，+3 分！`; }
  } else if (r.type === 'reaction') {
    const t1 = Number(a1), t2 = Number(a2);
    if (t1 < 0 || t2 < 0) result.detail = '有人没赶上点击，本轮不计分。';
    else if (Math.abs(t1-t2) < 5) { add(p1, 2); add(p2, 2); result.detail = '几乎同时！双方 +2 分'; }
    else if (t1 < t2) { add(p1, 3); add(p2, 1); result.detail = `${p1.name} 更快！+3 分，对手 +1 分`; }
    else { add(p2, 3); add(p1, 1); result.detail = `${p2.name} 更快！+3 分，对手 +1 分`; }
  } else if (r.type === 'choice') {
    if (a1 === a2) { add(p1, 3); add(p2, 3); result.detail = '心有灵犀！双方 +3 分'; }
    else { add(p1, 1); add(p2, 1); result.detail = '选择不同，各得参与分 +1'; }
  } else if (r.type === 'random') {
    const event = r.event;
    if (event.bonus === 3 && a1 === a2) { add(p1, 3); add(p2, 3); result.detail = '默契触发！双方 +3 分'; }
    else if (event.bonus === 2) { add(p1, 2); add(p2, 2); result.detail = '好运降临！双方 +2 分'; }
    else if (event.bonus === 1) { if (a1 === a2) { add(p1, 2); add(p2, 2); result.detail = '反应默契！双方 +2 分'; } else { add(p1, 1); add(p2, 1); result.detail = '双方各 +1 分'; } }
    else result.detail = '本轮纯娱乐，不加不扣分！';
  }
  r.finished = true;
  io.to(room.code).emit('round:result', { title: result.title, detail: result.detail, players: entries.map(p => ({ id: p.id, name: p.name, answer: r.answers[p.id], score: p.score, gained: result.scores[p.id] || 0 })), event: r.event || null });
  emitRoom(room);
}
io.on('connection', socket => {
  socket.on('room:create', ({ name }, cb) => {
    let c = code(); while (rooms.has(c)) c = code();
    const room = { code: c, players: new Map(), started: false, roundIndex: 0, current: null };
    room.players.set(socket.id, { id: socket.id, name: String(name || '玩家 1').slice(0, 16), score: 0, ready: true });
    rooms.set(c, room); socket.join(c);
    cb && cb({ ok: true, code: c, invite: null }); emitRoom(room);
  });
  socket.on('room:join', ({ code: c, name }, cb) => {
    c = String(c || '').toUpperCase().trim();
    const room = rooms.get(c);
    if (!room) return cb && cb({ ok: false, error: '房间不存在或已关闭，请让好友重新创建房间。' });
    if (room.players.size >= 2 && !room.players.has(socket.id)) return cb && cb({ ok: false, error: '房间已满，每个房间只能有两位玩家。' });
    if (!room.players.has(socket.id)) room.players.set(socket.id, { id: socket.id, name: String(name || '玩家 2').slice(0, 16), score: 0, ready: true });
    socket.join(c); cb && cb({ ok: true, code: c }); emitRoom(room);
  });
  socket.on('game:start', () => {
    const room = getRoomFor(socket); if (!room || room.players.size !== 2) return;
    room.started = true; room.roundIndex = 0; room.players.forEach(p => p.score = 0);
    startRound(room); emitRoom(room);
  });
  socket.on('round:answer', ({ answer }) => {
    const room = getRoomFor(socket); if (!room || !room.current || room.current.finished || !room.players.has(socket.id)) return;
    if (room.current.answers[socket.id] !== undefined) return;
    room.current.answers[socket.id] = answer;
    io.to(room.code).emit('round:progress', { count: Object.keys(room.current.answers).length });
    finishRound(room);
  });
  socket.on('game:next', () => {
    const room = getRoomFor(socket); if (!room || !room.current || !room.current.finished) return;
    room.roundIndex++;
    if (room.roundIndex >= rounds.length) {
      room.started = false;
      const standings = [...room.players.values()].sort((a,b) => b.score-a.score).map(p => ({ name: p.name, score: p.score, id: p.id }));
      io.to(room.code).emit('game:over', { standings }); emitRoom(room); return;
    }
    startRound(room); emitRoom(room);
  });
  socket.on('disconnect', () => {
    const room = getRoomFor(socket);
    if (!room) return;
    room.players.delete(socket.id);
    if (room.players.size === 0) rooms.delete(room.code);
    else { room.started = false; room.current = null; io.to(room.code).emit('notice', '好友已断开连接，房间暂时回到等待状态。'); emitRoom(room); }
  });
});
function startRound(room) {
  const type = rounds[room.roundIndex];
  const r = { type, answers: {}, finished: false };
  if (type === 'quiz') { const q = questions[Math.floor(Math.random()*questions.length)]; r.prompt=q.q; r.options=q.a; r.title='同步答题'; r.tip='同时选出你的答案，看看你们有多默契！'; }
  if (type === 'rps') { r.prompt='出拳！'; r.options=['石头','剪刀','布']; r.title='猜拳对决'; r.tip='双方选好后同时揭晓。'; }
  if (type === 'reaction') { r.prompt='等绿色出现，立刻点击！'; r.options=[]; r.title='反应力挑战'; r.tip='先准备好，信号出现前不要点。'; r.signalAt=Date.now()+1800+Math.floor(Math.random()*1800); }
  if (type === 'choice') { const q=choices[Math.floor(Math.random()*choices.length)]; r.prompt=q.q; r.options=q.a; r.title='趣味选择'; r.tip='选择你的偏好，看看是否一样。'; }
  if (type === 'random') { const e=randomEvents[Math.floor(Math.random()*randomEvents.length)]; r.event=e; r.prompt=e.title; r.options=['接受挑战','来点好运']; r.title='随机事件'; r.tip=e.desc; }
  room.current=r;
  io.to(room.code).emit('round:start', { type:r.type, title:r.title, prompt:r.prompt, options:r.options, tip:r.tip, round:room.roundIndex+1, total:rounds.length, signalAt:r.signalAt, event:r.event || null, serverNow:Date.now() });
}
server.listen(PORT, () => console.log(`默契挑战运行中：http://localhost:${PORT}`));
