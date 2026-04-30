# Costly Communication Shapes Networked Social Learning

This repository contains the experiment server, automated agent policy, frozen simulation database, and analysis script for the CogSci 2026 paper:

**Costly Communication Shapes Networked Social Learning: Accuracy--Utility Tradeoffs in an Agent-Based Model**

## Repository contents

```text
server.js                         Experiment server
db.js                             SQLite schema and prepared statements
experiment.js                     Private-signal sampling and ring-network utilities
public/                           Minimal browser client
scripts/bot.js                    Automated agent policy used for simulations
analysis/make_paper_figures.py    Script that reproduces the paper figures and summary tables
data/paper_main.sqlite            Frozen database used for the paper results
figures/                          Paper figures and summary CSV files
```

## Paper settings

The frozen paper run uses:

- group size: 8 agents
- rounds: 10
- round duration: 25 seconds
- network: degree-2 ring
- reward: 100 for a correct final guess
- cost levels: 1 and 5
- signal strengths: 0.2 and 0.4
- sigma: 1.0
- groups per condition cell: 40

The two communication regimes are:

| Parameter | Low-cost regime | High-cost regime |
|---|---:|---:|
| Per-round broadcast cap per agent | 4 | 1 |
| Broadcast probability per decision opportunity | 0.25 | 0.10 |
| Per-broadcast penalty | 1 | 5 |
| Social-update weight | 0.55 | 0.35 |

A broadcast is a sender-initiated event: it is delivered to both immediate neighbors, but counted once and charged once.

## Install

Install Node dependencies:

```bash
npm ci
```

Install Python dependencies:

```bash
python -m pip install -r requirements.txt
```

## Reproduce paper figures from the frozen database

```bash
python analysis/make_paper_figures.py \
  --db data/paper_main.sqlite \
  --out figures
```

This creates:

```text
figures/fig1_main_3panel.pdf
figures/fig1_main_3panel.png
figures/fig2_convergence_2panel.pdf
figures/fig2_convergence_2panel.png
figures/summary_main_by_condition.csv
figures/summary_convergence_by_round.csv
```

The confidence intervals are t-based 95% confidence intervals with 40 groups per condition cell, matching the paper.

You can also run the same command through npm:

```bash
npm run figures
```

## Running a new simulation

The paper figures are generated from the frozen database in `data/paper_main.sqlite`. Rerunning the simulation from scratch is stochastic and will not reproduce the exact numerical values unless the same database is used.

To start a new local server with the paper condition grid:

```bash
mkdir -p runs
SQLITE_PATH=runs/new_run.sqlite npm start
```

In another terminal, run one group of 8 automated agents:

```bash
npm run bot
```

Repeat the bot command until the quota is complete. The paper design contains 160 groups total: 2 cost levels x 2 signal-strength levels x 40 groups per cell.

## Notes on implementation

- Private signals are generated in log-odds space and converted to probabilities.
- Private probabilities are clipped to `[0.01, 0.99]` for numerical stability.
- Logged beliefs are analysis records. They are not messages and do not incur cost.
- The per-round broadcast cap and send probability are implemented in the automated agent policy in `scripts/bot.js`.
- The server records outgoing broadcasts in `message_events` and final choices in `final_events`.

## License

This code is released under the MIT License. See `LICENSE`.
