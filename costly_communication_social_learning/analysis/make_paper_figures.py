#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import argparse
import os
import sqlite3
import tempfile
from pathlib import Path

# Put Matplotlib's cache in a writable temp directory before importing pyplot.
os.environ.setdefault("MPLCONFIGDIR", str(Path(tempfile.gettempdir()) / "matplotlib"))

import numpy as np
import pandas as pd
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt


# The paper states t-based 95% CIs with n = 40 groups per condition.
# For df = 39, t_0.975 = 2.02269092.
T_CRIT_95_DF39 = 2.02269092


def ci95_t(series):
    """Return mean and t-based 95% CI using t_0.975,39, matching the paper."""
    x = pd.Series(series).dropna().astype(float)
    n = len(x)
    if n == 0:
        return pd.Series({"mean": np.nan, "n": 0, "sd": np.nan, "se": np.nan, "ci": np.nan})

    mean = x.mean()
    sd = x.std(ddof=1) if n > 1 else 0.0
    se = sd / np.sqrt(n) if n > 1 else 0.0

    # The paper design uses n=40 groups per condition cell, so df=39.
    # Downstream checks fail if a summary cell does not contain n=40 groups.
    ci = T_CRIT_95_DF39 * se
    return pd.Series({"mean": mean, "n": n, "sd": sd, "se": se, "ci": ci})


def load_group_level(con):
    groups = pd.read_sql_query(
        """
        SELECT group_id,
               condition_cost AS cost,
               kappa,
               sigma
        FROM groups
        """,
        con,
    )

    finals = pd.read_sql_query(
        """
        SELECT group_id,
               participant_id,
               correct,
               final_score
        FROM final_events
        """,
        con,
    )

    msgs = pd.read_sql_query(
        """
        SELECT group_id,
               participant_id
        FROM message_events
        """,
        con,
    )

    # Use final_events as the participant roster, so participants with zero messages are kept.
    participants = finals[["group_id", "participant_id"]].drop_duplicates()

    msg_cnt = (
        msgs.groupby(["group_id", "participant_id"])
        .size()
        .reset_index(name="n_msgs")
    )

    participant_msgs = participants.merge(
        msg_cnt, on=["group_id", "participant_id"], how="left"
    )
    participant_msgs["n_msgs"] = participant_msgs["n_msgs"].fillna(0)

    participant_msgs = participant_msgs.merge(groups, on="group_id", how="left")
    finals = finals.merge(groups, on="group_id", how="left")

    g_msg = (
        participant_msgs.groupby(["group_id", "cost", "kappa", "sigma"], as_index=False)
        .agg(avg_msgs=("n_msgs", "mean"))
    )

    g_acc_score = (
        finals.groupby(["group_id", "cost", "kappa", "sigma"], as_index=False)
        .agg(
            acc_group=("correct", "mean"),
            score_group=("final_score", "mean"),
        )
    )

    out = g_acc_score.merge(g_msg, on=["group_id", "cost", "kappa", "sigma"], how="left")
    return out


def load_convergence(con):
    """Return within-group belief variance by round.

    The aggregation is performed in SQLite to avoid loading all belief logs into
    memory. SQLite does not provide a built-in sample variance aggregate, so we
    compute it from count, mean, and mean square:
        var = n/(n-1) * (E[x^2] - E[x]^2)
    """
    rows = pd.read_sql_query(
        """
        SELECT
            b.group_id AS group_id,
            g.condition_cost AS cost,
            g.kappa AS kappa,
            g.sigma AS sigma,
            b.round AS round,
            COUNT(*) AS n_obs,
            AVG(b.belief_p) AS mean_p,
            AVG(b.belief_p * b.belief_p) AS mean_p2
        FROM belief_events AS b
        JOIN groups AS g ON b.group_id = g.group_id
        GROUP BY b.group_id, g.condition_cost, g.kappa, g.sigma, b.round
        """,
        con,
    )

    rows = rows[rows["n_obs"] > 1].copy()
    rows["belief_var"] = (
        rows["n_obs"] / (rows["n_obs"] - 1)
        * (rows["mean_p2"] - rows["mean_p"] * rows["mean_p"])
    )
    rows["belief_var"] = rows["belief_var"].clip(lower=0)

    return rows[["group_id", "cost", "kappa", "sigma", "round", "belief_var"]]


def summarize_main(df):
    rows = []
    for (cost, kappa), g in df.groupby(["cost", "kappa"]):
        row = {
            "cost": int(cost),
            "kappa": float(kappa),
        }
        for col in ["avg_msgs", "acc_group", "score_group"]:
            s = ci95_t(g[col])
            row[f"{col}_mean"] = s["mean"]
            row[f"{col}_ci"] = s["ci"]
            row[f"{col}_n"] = s["n"]
        rows.append(row)

    return pd.DataFrame(rows).sort_values(["cost", "kappa"]).reset_index(drop=True)


def summarize_convergence(df_var):
    rows = []
    for (cost, kappa, round_), g in df_var.groupby(["cost", "kappa", "round"]):
        s = ci95_t(g["belief_var"])
        rows.append({
            "cost": int(cost),
            "kappa": float(kappa),
            "round": int(round_),
            "mean": s["mean"],
            "ci": s["ci"],
            "n": s["n"],
        })

    return pd.DataFrame(rows).sort_values(["cost", "kappa", "round"]).reset_index(drop=True)


def set_style():
    plt.rcParams.update({
        "figure.dpi": 120,
        "savefig.dpi": 300,
        "font.family": "DejaVu Sans",
        "font.size": 10,
        "axes.titlesize": 11,
        "axes.labelsize": 10,
        "xtick.labelsize": 9,
        "ytick.labelsize": 9,
        "legend.fontsize": 9,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "axes.grid": True,
        "grid.alpha": 0.25,
        "grid.linewidth": 0.6,
        "pdf.fonttype": 42,
        "ps.fonttype": 42,
    })


def add_panel_label(ax, label):
    ax.text(
        -0.18, 1.08, label,
        transform=ax.transAxes,
        fontsize=12,
        fontweight="bold",
        va="top",
        ha="left",
    )


def draw_main_panel(
    ax,
    raw_df,
    summ_df,
    y_raw,
    y_mean,
    y_ci,
    y_label,
    kappa_levels,
    cost_order,
    cost_labels,
    colors,
    markers,
    linestyles,
    add_chance_line=False,
):
    x_map = {k: i for i, k in enumerate(kappa_levels)}
    offsets = {cost_order[0]: -0.09, cost_order[1]: 0.09}
    rng = np.random.default_rng(2026)

    for cost in cost_order:
        sub = raw_df[raw_df["cost"] == cost].copy()
        xs = sub["kappa"].map(x_map).astype(float) + offsets[cost]
        xs = xs + rng.normal(0, 0.015, size=len(xs))

        ax.scatter(
            xs,
            sub[y_raw],
            s=15,
            alpha=0.28,
            color=colors[cost],
            edgecolors="none",
            zorder=1,
        )

    for cost in cost_order:
        sub = summ_df[summ_df["cost"] == cost].sort_values("kappa")
        xs = np.array([x_map[k] for k in sub["kappa"]], dtype=float) + offsets[cost]
        ys = sub[y_mean].to_numpy(dtype=float)
        cis = sub[y_ci].to_numpy(dtype=float)

        ax.errorbar(
            xs,
            ys,
            yerr=cis,
            fmt=markers[cost],
            linestyle=linestyles[cost],
            linewidth=1.8,
            markersize=5,
            capsize=3,
            color=colors[cost],
            label=cost_labels[cost],
            zorder=3,
        )

    ax.set_xticks(range(len(kappa_levels)))
    ax.set_xticklabels([f"{k:.1f}" for k in kappa_levels])
    ax.set_xlabel(r"Signal strength $\kappa$")
    ax.set_ylabel(y_label)

    if add_chance_line:
        ax.axhline(0.5, linestyle="--", linewidth=1.0, color="0.35", zorder=0)

    ax.margins(x=0.08)


def plot_main_figure(df, out_dir):
    cost_order = [1, 5]
    cost_labels = {
        1: "Low-cost regime",
        5: "High-cost regime",
    }
    colors = {
        1: "#1f77b4",
        5: "#d55e00",
    }
    markers = {
        1: "o",
        5: "s",
    }
    linestyles = {
        1: "-",
        5: "--",
    }

    df = df.copy()
    df["cost"] = df["cost"].astype(int)
    df["kappa"] = df["kappa"].astype(float)

    summ = summarize_main(df)

    n_cols = [c for c in summ.columns if c.endswith("_n")]
    bad_main_n = summ.loc[~summ[n_cols].eq(40).all(axis=1), ["cost", "kappa"] + n_cols]
    if len(bad_main_n) > 0:
        raise ValueError(
            "Expected n=40 groups in every main condition cell, but found:\n"
            + bad_main_n.to_string(index=False)
        )

    kappa_levels = sorted(df["kappa"].unique())

    fig, axes = plt.subplots(1, 3, figsize=(11.3, 3.55))

    draw_main_panel(
        axes[0],
        df,
        summ,
        y_raw="avg_msgs",
        y_mean="avg_msgs_mean",
        y_ci="avg_msgs_ci",
        y_label="Outgoing broadcasts / participant",
        kappa_levels=kappa_levels,
        cost_order=cost_order,
        cost_labels=cost_labels,
        colors=colors,
        markers=markers,
        linestyles=linestyles,
    )
    axes[0].set_title("Outgoing broadcasts")
    add_panel_label(axes[0], "A")

    draw_main_panel(
        axes[1],
        df,
        summ,
        y_raw="acc_group",
        y_mean="acc_group_mean",
        y_ci="acc_group_ci",
        y_label="Accuracy",
        kappa_levels=kappa_levels,
        cost_order=cost_order,
        cost_labels=cost_labels,
        colors=colors,
        markers=markers,
        linestyles=linestyles,
        add_chance_line=True,
    )
    axes[1].set_title("Accuracy")
    axes[1].set_ylim(-0.02, 1.02)
    add_panel_label(axes[1], "B")

    draw_main_panel(
        axes[2],
        df,
        summ,
        y_raw="score_group",
        y_mean="score_group_mean",
        y_ci="score_group_ci",
        y_label="Mean final score",
        kappa_levels=kappa_levels,
        cost_order=cost_order,
        cost_labels=cost_labels,
        colors=colors,
        markers=markers,
        linestyles=linestyles,
    )
    axes[2].set_title("Net utility")
    add_panel_label(axes[2], "C")

    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(
        handles,
        labels,
        loc="upper center",
        ncol=2,
        frameon=False,
        bbox_to_anchor=(0.5, 1.08),
    )

    fig.tight_layout(rect=[0, 0, 1, 0.96])

    fig.savefig(out_dir / "fig1_main_3panel.pdf", bbox_inches="tight")
    fig.savefig(out_dir / "fig1_main_3panel.png", bbox_inches="tight")
    plt.close(fig)

    summ.to_csv(out_dir / "summary_main_by_condition.csv", index=False)


def plot_convergence_figure(df_var, out_dir):
    cost_order = [1, 5]
    cost_titles = {
        1: "Low-cost regime",
        5: "High-cost regime",
    }

    df_var = df_var.copy()
    df_var["cost"] = df_var["cost"].astype(int)
    df_var["kappa"] = df_var["kappa"].astype(float)
    df_var["round"] = df_var["round"].astype(int)

    kappa_levels = sorted(df_var["kappa"].unique())
    colors = {
        kappa_levels[0]: "#009e73",
        kappa_levels[1]: "#cc79a7",
    }
    markers = {
        kappa_levels[0]: "o",
        kappa_levels[1]: "s",
    }
    linestyles = {
        kappa_levels[0]: "-",
        kappa_levels[1]: "--",
    }

    summ = summarize_convergence(df_var)

    bad_conv_n = summ.loc[summ["n"] != 40, ["cost", "kappa", "round", "n"]]
    if len(bad_conv_n) > 0:
        raise ValueError(
            "Expected n=40 groups in every convergence condition-round cell, but found:\n"
            + bad_conv_n.to_string(index=False)
        )

    fig, axes = plt.subplots(1, 2, figsize=(8.3, 3.45), sharey=True)

    for ax, cost in zip(axes, cost_order):
        sub = summ[summ["cost"] == cost]

        for kappa in kappa_levels:
            s = sub[sub["kappa"] == kappa].sort_values("round")
            x = s["round"].to_numpy(dtype=int)
            y = s["mean"].to_numpy(dtype=float)
            ci = s["ci"].to_numpy(dtype=float)

            ax.plot(
                x,
                y,
                marker=markers[kappa],
                linestyle=linestyles[kappa],
                linewidth=1.8,
                markersize=4,
                color=colors[kappa],
                label=rf"$\kappa={kappa:.1f}$",
            )
            ax.fill_between(
                x,
                y - ci,
                y + ci,
                color=colors[kappa],
                alpha=0.18,
            )

        ax.set_title(cost_titles[cost])
        ax.set_xlabel("Round")
        ax.set_xlim(sub["round"].min(), sub["round"].max())
        ax.legend(frameon=False)

    axes[0].set_ylabel("Variance of logged beliefs")
    add_panel_label(axes[0], "A")
    add_panel_label(axes[1], "B")

    fig.tight_layout()

    fig.savefig(out_dir / "fig2_convergence_2panel.pdf", bbox_inches="tight")
    fig.savefig(out_dir / "fig2_convergence_2panel.png", bbox_inches="tight")
    plt.close(fig)

    summ.to_csv(out_dir / "summary_convergence_by_round.csv", index=False)


def main():
    parser = argparse.ArgumentParser(
        description="Create revised paper figures for the CogSci communication-cost model."
    )
    parser.add_argument(
        "--db",
        required=True,
        help="Path to SQLite database file.",
    )
    parser.add_argument(
        "--out",
        default="figures",
        help="Output directory.",
    )
    args = parser.parse_args()

    db_path = Path(args.db)
    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    con = sqlite3.connect(str(db_path))
    try:
        df = load_group_level(con)
        df_var = load_convergence(con)
    finally:
        con.close()

    set_style()
    plot_main_figure(df, out_dir)
    plot_convergence_figure(df_var, out_dir)

    print(f"Done. Figures written to: {out_dir.resolve()}")


if __name__ == "__main__":
    main()
