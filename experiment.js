function sigmoid(x) {
  return 1 / (1 + Math.exp(-x));
}

function randn() {
  // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function samplePrivateP(hiddenState, kappa, sigma) {
  const sign = hiddenState === 1 ? 1 : -1;
  const z = kappa * sign + sigma * randn();
  const p = sigmoid(z);
  // Clip probabilities away from 0 and 1 for numerical stability in log-odds updates.
  return Math.min(0.99, Math.max(0.01, p));
}

function makeRingAdjacency(n) {
  // degree=2 ring
  const neighbors = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    neighbors[i].push((i - 1 + n) % n);
    neighbors[i].push((i + 1) % n);
  }
  return neighbors;
}

module.exports = { samplePrivateP, makeRingAdjacency };
