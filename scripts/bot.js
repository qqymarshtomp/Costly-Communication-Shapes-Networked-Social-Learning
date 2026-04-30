// scripts/bot.js
const { io } = require("socket.io-client");

const URL = process.env.URL || "http://localhost:3000";
const BOTS = process.env.BOTS ? Number(process.env.BOTS) : 8;

function clamp(p) {
  return Math.min(0.999999, Math.max(0.000001, p));
}
function logit(p) {
  const x = clamp(p);
  return Math.log(x / (1 - x));
}
function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

let finished = 0;

for (let i = 0; i < BOTS; i++) {
  const sock = io(URL, { transports: ["websocket"] });

  sock.on("connect", () => {
    console.log("bot connected", i);
    sock.emit("join");
  });

  sock.on("closed", (x) => {
    console.log("bot closed", i, x?.reason);
    sock.disconnect();
    finished += 1;
    if (finished >= BOTS) {
      console.log("all bots finished (closed)");
      process.exit(0);
    }
  });

  sock.on("connect_error", (err) => {
    console.log("bot connect_error", i, err.message);
  });

  sock.on("init", (x) => {
    const cost = Number(x.cost);
    const privateP = Number(x.privateP);

    console.log("bot init", i, "group", x.groupId, "cost", cost, "privateP", privateP.toFixed(3));

    // Belief state initialized from the private signal.
    let z = logit(privateP);

    // Social-update weight used when a neighbor message arrives.
    // The high-cost regime uses a smaller social-update weight.
    const alpha = cost >= 5 ? 0.35 : 0.55;

    // Cost-sensitive broadcast probability and per-round cap.
    const maxPerRound = cost >= 5 ? 1 : 4;
    const sendProb = cost >= 5 ? 0.10 : 0.25;

    let sentThisRound = 0;

    sock.on("round_start", () => {
      sentThisRound = 0;
    });

    // Neighbor messages are converted to log-odds and then combined with the current belief.
    sock.on("incoming_message", (m) => {
      const msgP = Number(m.msgP);
      if (!Number.isFinite(msgP)) return;
      const zMsg = logit(msgP);
      z = (1 - alpha) * z + alpha * zMsg;
    });

    // Every 2 seconds, log the current belief and possibly initiate an outgoing broadcast.
    const t = setInterval(() => {
      const p = sigmoid(z);
      sock.emit("submit_belief", { beliefP: p });

      if (sentThisRound < maxPerRound && Math.random() < sendProb) {
        sock.emit("send_message", { msgP: p });
        sentThisRound += 1;
      }
    }, 2000);

    sock.on("experiment_end", () => {
      clearInterval(t);

      const pFinal = sigmoid(z);
      const finalGuess = pFinal >= 0.5 ? 1 : 0;
      sock.emit("submit_final", { finalGuess });

      setTimeout(() => {
        sock.disconnect();
        finished += 1;
        if (finished >= BOTS) {
          console.log("all bots finished");
          process.exit(0);
        }
      }, 1500);
    });
  });
}
