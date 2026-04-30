const socket = io();

const joinBtn = document.getElementById("joinBtn");
const statusDiv = document.getElementById("status");
const taskBox = document.getElementById("taskBox");

const groupIdSpan = document.getElementById("groupId");
const roundSpan = document.getElementById("round");
const costSpan = document.getElementById("cost");
const rewardSpan = document.getElementById("reward");
const privatePSpan = document.getElementById("privateP");
const neighborsSpan = document.getElementById("neighbors");

const beliefSlider = document.getElementById("beliefSlider");
const beliefVal = document.getElementById("beliefVal");
const submitBeliefBtn = document.getElementById("submitBeliefBtn");
const sendMsgBtn = document.getElementById("sendMsgBtn");
const msgInfo = document.getElementById("msgInfo");

const messagesDiv = document.getElementById("messages");
const final0 = document.getElementById("final0");
const final1 = document.getElementById("final1");
const finalAck = document.getElementById("finalAck");

let currentRound = 0;

function appendMsg(text) {
  const p = document.createElement("div");
  p.textContent = text;
  messagesDiv.appendChild(p);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

beliefSlider.addEventListener("input", () => {
  beliefVal.textContent = Number(beliefSlider.value).toFixed(2);
});

joinBtn.addEventListener("click", () => {
  socket.emit("join");
});

submitBeliefBtn.addEventListener("click", () => {
  const p = Number(beliefSlider.value);
  socket.emit("submit_belief", { beliefP: p });
});

sendMsgBtn.addEventListener("click", () => {
  const p = Number(beliefSlider.value);
  socket.emit("send_message", { msgP: p });
});

final0.addEventListener("click", () => socket.emit("submit_final", { finalGuess: 0 }));
final1.addEventListener("click", () => socket.emit("submit_final", { finalGuess: 1 }));

socket.on("connect", () => {
  statusDiv.textContent = "Connected. Click Join.";
});

socket.on("waiting", (x) => {
  statusDiv.textContent = `Waiting... (${x.current}/${x.needed})`;
});

socket.on("init", (x) => {
  taskBox.style.display = "block";
  groupIdSpan.textContent = x.groupId;
  roundSpan.textContent = "0";
  costSpan.textContent = String(x.cost);
  rewardSpan.textContent = String(x.reward);
  privatePSpan.textContent = Number(x.privateP).toFixed(2);
  neighborsSpan.textContent = x.neighbors.join(", ");
  beliefSlider.value = Number(x.privateP).toFixed(2);
  beliefVal.textContent = Number(x.privateP).toFixed(2);
  appendMsg(`System: joined group. Your private p=${Number(x.privateP).toFixed(2)}.`);
});

socket.on("round_start", (x) => {
  currentRound = x.round;
  roundSpan.textContent = String(x.round);
  appendMsg(`System: round ${x.round} started.`);
});

socket.on("round_end", (x) => {
  appendMsg(`System: round ${x.round} ended.`);
});

socket.on("incoming_message", (m) => {
  appendMsg(`From neighbor ${m.fromIndex} (round ${m.round}): p=${Number(m.msgP).toFixed(2)}`);
});

socket.on("message_sent", (m) => {
  msgInfo.textContent = `sent. msgCount=${m.msgCount}, cost per msg=${m.cost}`;
});

socket.on("experiment_end", () => {
  appendMsg("System: experiment ended. Please submit final guess.");
});

socket.on("final_ack", (x) => {
  finalAck.textContent = ` final score=${x.score}`;
});
