// ---------- Elements ----------
const themeToggle = document.getElementById("theme-toggle");
const themeLabel = document.getElementById("theme-label");

const uploadBox = document.getElementById("upload-box");
const uploadLabel = document.getElementById("upload-label");
const pdfInput = document.getElementById("pdf-input");
const docNameEl = document.getElementById("doc-name");

const messagesEl = document.getElementById("messages");
const composer = document.getElementById("composer");
const questionInput = document.getElementById("question-input");
const sendBtn = document.getElementById("send-btn");
const providerSelect = document.getElementById("provider-select");
const micBtn = document.getElementById("mic-btn");

const evidenceList = document.getElementById("evidence-list");

let ws = null;
let currentAuthorBubble = null;
let currentRawText = "";
let thinkingEl = null;
let placeholderCleared = false;

// ---------- Markdown-lite rendering (bold only, HTML-escaped first) ----------
function escapeHTML(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function renderMarkdownLite(text) {
  let escaped = escapeHTML(text);
  escaped = escaped.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  escaped = escaped.replace(/\*/g, ""); // drop any stray/unmatched asterisks
  return escaped;
}

// ---------- Audio playback queue ----------
// The backend sends one "audio" message per completed sentence, not one at
// the end. Playback has to queue these and play strictly one at a time.
// ---------- Audio playback queue ----------
let audioQueue = [];
let isPlayingAudio = false;
let currentAudio = null;

function stopAllAudio() {
  audioQueue = [];
  isPlayingAudio = false;
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.src = "";
    currentAudio = null;
  }
}

function enqueueAudio(url) {
  audioQueue.push(url);
  if (!isPlayingAudio) {
    playNextAudio();
  }
}

function playNextAudio() {
  if (audioQueue.length === 0) {
    isPlayingAudio = false;
    currentAudio = null;
    return;
  }

  isPlayingAudio = true;
  const url = audioQueue.shift();
  
  currentAudio = new Audio(url);

  const onEndedOrError = () => {
    currentAudio = null;
    playNextAudio();
  };

  currentAudio.onended = onEndedOrError;
  currentAudio.onerror = onEndedOrError;

  currentAudio.play().catch((err) => {
    console.warn("Playback interrupted or failed, playing next chunk:", err);
    onEndedOrError();
  });
}

// ---------- Theme ----------
function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  themeLabel.textContent = theme;
  localStorage.setItem("socrates-theme", theme);
}

const savedTheme = localStorage.getItem("socrates-theme") || "dark";
applyTheme(savedTheme);

themeToggle.addEventListener("click", () => {
  const current = document.documentElement.getAttribute("data-theme");
  applyTheme(current === "dark" ? "light" : "dark");
});

// ---------- Upload ----------
uploadBox.addEventListener("click", () => pdfInput.click());

pdfInput.addEventListener("change", () => {
  const file = pdfInput.files[0];
  if (file) handleUpload(file);
});

async function handleUpload(file) {
  if (file.type !== "application/pdf") {
    uploadLabel.textContent = "# Please choose a PDF file.";
    return;
  }

  uploadLabel.textContent = `# Ingesting ${file.name}...`;

  const formData = new FormData();
  formData.append("file", file);

  try {
    const res = await fetch("/upload", { method: "POST", body: formData });
    const data = await res.json();

    uploadLabel.textContent = `# Loaded: ${data.filename} (${data.chunks_ingested} chunks)`;
    docNameEl.textContent = `# ${data.filename}`;

    clearPlaceholder();
    enableComposer();
    connectWebSocket();
  } catch (err) {
    uploadLabel.textContent = "# Upload failed. Try again.";
    console.error(err);
  }
}

function enableComposer() {
  questionInput.disabled = false;
  sendBtn.disabled = false;
  micBtn.disabled = false;
  questionInput.focus();
}

function clearPlaceholder() {
  if (!placeholderCleared) {
    messagesEl.innerHTML = "";
    placeholderCleared = true;
  }
}

// ---------- WebSocket ----------
function connectWebSocket() {
  if (ws) {
    ws.onmessage = null;
    ws.onclose = null;
    ws.close();
  }

  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const socket = new WebSocket(`${protocol}://${window.location.host}/chat`);
  ws = socket;

  socket.onmessage = (event) => {
    if (socket !== ws) return; // ignore messages from a socket that's been replaced

    const data = JSON.parse(event.data);

    if (data.type === "token") {
      removeThinking();
      if (!currentAuthorBubble) {
        currentAuthorBubble = addMessage("author", "");
        currentRawText = "";
      }
      currentRawText += data.content;
      currentAuthorBubble.innerHTML = renderMarkdownLite(currentRawText);
      scrollToBottom();
    }

    if (data.type === "sources") {
      renderEvidence(data.sources);
    }

    if (data.type === "audio") {
      enqueueAudio(data.url);
    }

    if (data.type === "done") {
      removeThinking();
      currentAuthorBubble = null;
      currentRawText = "";
      setComposerBusy(false);
    }
  };

  socket.onclose = () => {
    if (socket !== ws) return; // this socket was already replaced, don't double-reconnect
    console.warn("WebSocket closed. Reconnecting in 1s...");
    setTimeout(connectWebSocket, 1000);
  };
}

// ---------- Sending a question (shared by text + voice) ----------
function sendQuestion(question, mode) {
  if (!question || !ws || ws.readyState !== WebSocket.OPEN) return;

  stopAllAudio();
  currentAuthorBubble = null;
  currentRawText = "";
  clearPlaceholder();
  addMessage("user", question);
  addThinking();

  ws.send(JSON.stringify({
    question: question,
    provider: providerSelect.value,
    mode: mode
  }));

  setComposerBusy(true);
}

function stopGeneration() {
  stopAllAudio();
  removeThinking();
  currentAuthorBubble = null;
  currentRawText = "";
  setComposerBusy(false);
  connectWebSocket(); // kills the in-flight backend response
}

composer.addEventListener("submit", (e) => {
  e.preventDefault();

  if (sendBtn.dataset.mode === "stop") {
    stopGeneration();
    return;
  }

  const question = questionInput.value.trim();
  sendQuestion(question, "text");
  questionInput.value = "";
});

function setComposerBusy(isBusy) {
  questionInput.disabled = isBusy;
  micBtn.disabled = isBusy;

  if (isBusy) {
    sendBtn.textContent = "[ stop ]";
    sendBtn.dataset.mode = "stop";
    sendBtn.disabled = false; // must stay clickable so it can be interrupted
  } else {
    sendBtn.textContent = "[ send ]";
    sendBtn.dataset.mode = "send";
    sendBtn.disabled = false;
    questionInput.focus();
  }
}

// ---------- Voice input ----------
let mediaRecorder;
let audioChunks = [];
let isRecording = false;

micBtn.addEventListener("click", async () => {
  if (!isRecording) {
    stopAllAudio(); // don't let a previous answer talk over the user

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => audioChunks.push(e.data);
    mediaRecorder.start();
    isRecording = true;
    micBtn.textContent = "[ stop ]";
    micBtn.classList.add("recording");
  } else {
    mediaRecorder.stop();
    isRecording = false;
    micBtn.textContent = "[ mic ]";
    micBtn.classList.remove("recording");

    mediaRecorder.onstop = async () => {
      const audioBlob = new Blob(audioChunks, { type: "audio/webm" });
      const formData = new FormData();
      formData.append("file", audioBlob, "question.webm");

      micBtn.disabled = true;
      const res = await fetch("/transcribe", { method: "POST", body: formData });
      const data = await res.json();
      micBtn.disabled = false;

      if (data.text) sendQuestion(data.text, "voice");
    };
  }
});

// ---------- Thinking indicator (rotating diamond) ----------
function addThinking() {
  const wrapper = document.createElement("div");
  wrapper.className = "message thinking";
  wrapper.innerHTML = `
    <span class="diamond"></span>
    <span class="thinking-label">thinking...</span>
  `;
  messagesEl.appendChild(wrapper);
  scrollToBottom();
  thinkingEl = wrapper;
}

function removeThinking() {
  if (thinkingEl) {
    thinkingEl.remove();
    thinkingEl = null;
  }
}

// ---------- Rendering ----------
function addMessage(role, text) {
  const wrapper = document.createElement("div");
  wrapper.className = `message message-${role}`;

  const label = document.createElement("span");
  label.className = "role-label";
  wrapper.appendChild(label);

  const p = document.createElement("p");
  if (role === "user") {
    p.textContent = text; // user text never needs markdown rendering
  } else {
    p.innerHTML = renderMarkdownLite(text);
  }
  wrapper.appendChild(p);

  messagesEl.appendChild(wrapper);
  scrollToBottom();
  return p;
}

function renderEvidence(sources) {
  evidenceList.innerHTML = "";

  if (!sources || sources.length === 0) {
    evidenceList.innerHTML = '<p class="dim placeholder"># No sources for this answer.</p>';
    return;
  }

  sources.forEach((src) => {
    const item = document.createElement("div");
    item.className = "evidence-item";

    const label = document.createElement("span");
    label.className = "source-label";
    label.textContent = `# page ${src.page}`;

    const text = document.createElement("p");
    text.className = "source-text";
    text.textContent = src.text;

    item.appendChild(label);
    item.appendChild(text);
    evidenceList.appendChild(item);
  });
}

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}