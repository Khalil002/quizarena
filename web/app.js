// quizarena web client: REST for commands, one WebSocket per room for live state.
const state = {
  token: localStorage.getItem("qa.token"),
  user: null,
  room: null,
  socket: null,
  picked: {}, // questionIndex -> optionIndex
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function api(method, path, body) {
  const res = await fetch(`/api${path}`, {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(state.token ? { authorization: `Bearer ${state.token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw Object.assign(new Error(data?.title ?? `HTTP ${res.status}`), { code: data?.code });
  return { data, headers: res.headers };
}

let toastTimer;
function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("#toast").classList.add("hidden"), 3000);
}

function show(view) {
  for (const id of ["auth-view", "home-view", "room-view"]) $(`#${id}`).classList.toggle("hidden", id !== view);
}

// --- session -------------------------------------------------------------------

async function boot() {
  api("GET", "/health").then(({ data }) => { $("#backend").textContent = `backend: ${data.backend}`; })
    .catch(() => { $("#backend").textContent = "backend: offline"; });
  if (state.token) {
    try { state.user = (await api("GET", "/me")).data; } catch { state.token = null; }
  }
  renderSession();
  const code = location.hash.match(/^#room=([A-Z2-9]{6})$/)?.[1];
  if (state.user && code) return enterRoom(code);
  state.user ? goHome() : show("auth-view");
}

function renderSession() {
  $("#session").innerHTML = state.user
    ? `<span>${esc(state.user.displayName)}</span><button class="ghost" id="logout">Log out</button>`
    : "";
  if (state.user) $("#logout").onclick = () => {
    localStorage.removeItem("qa.token");
    location.hash = "";
    location.reload();
  };
}

$("#auth-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const mode = event.submitter?.dataset.mode ?? "login";
  const f = new FormData(event.target);
  const body = { email: f.get("email"), password: f.get("password") };
  if (mode === "register") body.displayName = f.get("displayName");
  try {
    const { data } = await api("POST", `/auth/${mode}`, body);
    state.token = data.token;
    state.user = data.user;
    localStorage.setItem("qa.token", data.token);
    renderSession();
    goHome();
  } catch (err) {
    toast(err.message);
  }
});

$("#home-link").addEventListener("click", (e) => { e.preventDefault(); if (state.user) goHome(); });

// --- home ----------------------------------------------------------------------

async function goHome() {
  leaveRoom();
  location.hash = "";
  show("home-view");
  const [quizzes, history, board] = await Promise.all([
    api("GET", "/quizzes"), api("GET", "/me/matches"), api("GET", "/leaderboard"),
  ]);
  $("#quizzes").innerHTML = quizzes.data.map((q) => `
    <li><span>${esc(q.title)} <span class="muted small">${q.questionCount} questions</span></span>
    <button data-host="${q.id}">Host</button></li>`).join("") || `<li class="muted">No quizzes yet</li>`;
  $("#history").innerHTML = history.data.map((m) => `
    <li><span>${esc(m.quizTitle)} <span class="muted small">#${m.rank} of ${m.playerCount}</span></span>
    <span class="badge">${m.score} pts</span></li>`).join("") || `<li class="muted">Play a game to see it here</li>`;
  $("#leaderboard").innerHTML = board.data.map((r) => `
    <li><span>${esc(r.displayName)}</span><span class="badge">${r.totalScore}</span></li>`).join("")
    || `<li class="muted">No finished games yet</li>`;
  $("#lb-cache").textContent = `cache: ${board.headers.get("x-cache")}`;
  if (!$("#question-fields").children.length) addQuestionField();
}

$("#quizzes").addEventListener("click", async (event) => {
  const quizId = event.target.dataset.host;
  if (!quizId) return;
  try {
    const { data } = await api("POST", "/rooms", { quizId });
    enterRoom(data.code);
  } catch (err) {
    toast(err.message);
  }
});

$("#join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const code = new FormData(event.target).get("code").toUpperCase().trim();
  try {
    await api("POST", `/rooms/${code}/join`);
    enterRoom(code);
  } catch (err) {
    toast(err.message);
  }
});

function addQuestionField() {
  const div = document.createElement("div");
  div.className = "question-field";
  div.innerHTML = `
    <input name="prompt" placeholder="question" required maxlength="300" />
    <div class="row">${[0, 1, 2, 3].map((i) => `<input name="opt${i}" placeholder="option ${i + 1}${i > 1 ? " (optional)" : ""}" ${i < 2 ? "required" : ""} maxlength="100" />`).join("")}</div>
    <div class="row">
      <label class="muted small">correct <select name="correct"><option value="0">1</option><option value="1">2</option><option value="2">3</option><option value="3">4</option></select></label>
      <label class="muted small">seconds <input name="seconds" type="number" min="5" max="120" value="20" style="width:6em" /></label>
    </div>`;
  $("#question-fields").appendChild(div);
}
$("#add-question").addEventListener("click", addQuestionField);

$("#quiz-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const questions = [...document.querySelectorAll(".question-field")].map((el) => ({
    prompt: el.querySelector("[name=prompt]").value,
    options: [0, 1, 2, 3].map((i) => el.querySelector(`[name=opt${i}]`).value.trim()).filter(Boolean),
    correctIndex: Number(el.querySelector("[name=correct]").value),
    timeLimitSec: Number(el.querySelector("[name=seconds]").value),
  }));
  try {
    await api("POST", "/quizzes", { title: new FormData(event.target).get("title"), questions });
    event.target.reset();
    $("#question-fields").innerHTML = "";
    toast("Quiz saved");
    goHome();
  } catch (err) {
    toast(err.message);
  }
});

// --- room ----------------------------------------------------------------------

function enterRoom(code) {
  leaveRoom();
  location.hash = `room=${code}`;
  show("room-view");
  state.picked = {};
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/api/rooms/${code}/ws?token=${encodeURIComponent(state.token)}`);
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === "room.updated") { state.room = msg.room; renderRoom(); }
  };
  ws.onclose = (e) => {
    if (state.socket !== ws) return;
    if (e.code === 4404) { toast("Room not found"); goHome(); }
    else setTimeout(() => state.socket === ws && enterRoom(code), 1500); // reconnect
  };
  state.socket = ws;
}

function leaveRoom() {
  const ws = state.socket;
  state.socket = null;
  state.room = null;
  ws?.close();
}

const isHost = () => state.room?.hostId === state.user?.id;

function scoreboard(room) {
  return `<ol class="list scores">${room.players.map((p) => `
    <li><span>${esc(p.displayName)}${p.userId === state.user.id ? " (you)" : ""}</span>
    <span class="score">${p.score}</span></li>`).join("") || `<li class="muted">Waiting for players…</li>`}</ol>`;
}

function renderRoom() {
  const room = state.room;
  const host = isHost();
  let body = "";
  if (room.state === "lobby") {
    body = `
      <div class="card stage-head">
        <div><div class="muted">Join at this page with code</div><div class="room-code">${room.code}</div></div>
        ${host ? `<button id="start" ${room.players.length ? "" : "disabled"}>Start game</button>` : `<span class="badge">Waiting for the host</span>`}
      </div>
      <div class="card"><h2>${esc(room.quizTitle)} · ${room.players.length} player(s)</h2>${scoreboard(room)}</div>`;
  } else if (room.state === "question" || room.state === "reveal") {
    const q = room.question;
    const picked = state.picked[q.index];
    const reveal = room.state === "reveal";
    body = `
      <div class="card stage">
        <div class="stage-head">
          <span class="badge">Question ${q.index + 1} / ${room.questionCount}</span>
          <span class="muted">${room.answeredCount} / ${room.players.length} answered</span>
          ${host ? `<button id="next">${reveal ? (q.index + 1 < room.questionCount ? "Next question" : "Final results") : "Reveal answer"}</button>` : ""}
        </div>
        <div class="prompt">${esc(q.prompt)}</div>
        ${reveal ? "" : `<div class="timer"><div id="timer-bar"></div></div>`}
        <div class="options">${q.options.map((o, i) => {
          const cls = reveal ? (i === q.correctIndex ? "correct" : "dim") : picked === i ? "picked" : picked !== undefined ? "dim" : "";
          return `<button class="option ${cls}" data-option="${i}" ${host || reveal || picked !== undefined ? "disabled" : ""}>${esc(o)}</button>`;
        }).join("")}</div>
      </div>
      ${reveal ? `<div class="card"><h2>Scores</h2>${scoreboard(room)}</div>` : ""}`;
  } else {
    body = `<div class="card"><h2>Final standings · ${esc(room.quizTitle)}</h2>${scoreboard(room)}
      <p><button id="home">Back to lobby</button></p></div>`;
  }
  $("#room-view").innerHTML = `<div class="stage">${body}</div>`;
  $("#start")?.addEventListener("click", () => command("start"));
  $("#next")?.addEventListener("click", () => command("next"));
  $("#home")?.addEventListener("click", goHome);
  document.querySelectorAll("[data-option]").forEach((b) => b.addEventListener("click", () => answer(Number(b.dataset.option))));
}

async function command(name) {
  try { await api("POST", `/rooms/${state.room.code}/${name}`); } catch (err) { toast(err.message); }
}

async function answer(optionIndex) {
  const index = state.room.question.index;
  state.picked[index] = optionIndex;
  renderRoom();
  try {
    await api("POST", `/rooms/${state.room.code}/answer`, { questionIndex: index, optionIndex });
  } catch (err) {
    toast(err.message);
  }
}

// The timer is cosmetic: the server decides what counts as late.
setInterval(() => {
  const bar = $("#timer-bar");
  const q = state.room?.question;
  if (!bar || !q) return;
  const left = Math.max(0, new Date(q.deadline).getTime() - Date.now());
  bar.style.width = `${(100 * left) / (q.timeLimitSec * 1000)}%`;
}, 250);

boot();
