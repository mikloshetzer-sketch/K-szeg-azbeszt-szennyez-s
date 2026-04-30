/**
 * Kőszeg Azbeszt – Hírindex / Ügyindex diagram
 *
 * Ez a fájl a data/news_scores.json alapján:
 * - betölti a hírek pontozott adatait,
 * - napi összesítést készít,
 * - kumulált ügyindexet számol,
 * - Chart.js segítségével diagramot rajzol.
 *
 * Fontos:
 * Az index nem hangulatelemzés, hanem esemény-alapú ügyindex.
 */

let newsScoreChartInstance = null;

async function loadNewsScores() {
  const response = await fetch("data/news_scores.json?t=" + Date.now());

  if (!response.ok) {
    throw new Error("Nem sikerült betölteni a data/news_scores.json fájlt.");
  }

  return await response.json();
}

function groupScoresByDate(items) {
  const grouped = {};

  items.forEach((item) => {
    if (!item.date || typeof item.final_score !== "number") {
      return;
    }

    if (!grouped[item.date]) {
      grouped[item.date] = {
        date: item.date,
        daily_score: 0,
        items: []
      };
    }

    grouped[item.date].daily_score += item.final_score;
    grouped[item.date].items.push(item);
  });

  return Object.values(grouped).sort((a, b) => {
    return new Date(a.date) - new Date(b.date);
  });
}

function addCumulativeScores(dailyData) {
  let cumulative = 0;

  return dailyData.map((day) => {
    cumulative += day.daily_score;

    return {
      ...day,
      daily_score: Number(day.daily_score.toFixed(2)),
      cumulative_score: Number(cumulative.toFixed(2))
    };
  });
}

function formatScore(score) {
  if (score > 0) {
    return "+" + score;
  }

  return String(score);
}

function getBarColor(value) {
  if (value > 0) {
    return "rgba(34, 197, 94, 0.75)";
  }

  if (value < 0) {
    return "rgba(239, 68, 68, 0.75)";
  }

  return "rgba(148, 163, 184, 0.65)";
}

function getBarBorderColor(value) {
  if (value > 0) {
    return "rgba(134, 239, 172, 1)";
  }

  if (value < 0) {
    return "rgba(252, 165, 165, 1)";
  }

  return "rgba(203, 213, 225, 1)";
}

function createTooltipLines(day) {
  const lines = [];

  lines.push("Napi index: " + formatScore(day.daily_score));
  lines.push("Kumulált index: " + formatScore(day.cumulative_score));
  lines.push("");

  day.items.forEach((item) => {
    const score = formatScore(item.final_score);
    const source = item.source ? " / " + item.source : "";
    lines.push(score + " – " + item.title + source);
  });

  return lines;
}

function createScoreSummary(processedData) {
  const target = document.getElementById("newsScoreSummary");

  if (!target || !processedData.length) {
    return;
  }

  const latest = processedData[processedData.length - 1];
  const worst = processedData.reduce((a, b) => {
    return a.daily_score < b.daily_score ? a : b;
  });

  const best = processedData.reduce((a, b) => {
    return a.daily_score > b.daily_score ? a : b;
  });

  const trendText = latest.cumulative_score < 0
    ? "A kumulált index jelenleg negatív tartományban van, vagyis a hírek összhatása inkább kockázati irányba mutat."
    : latest.cumulative_score > 0
      ? "A kumulált index jelenleg pozitív tartományban van, vagyis az intézkedések és előremutató események erősebbek."
      : "A kumulált index jelenleg semleges.";

  target.innerHTML = `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:10px;">
      <div style="background:rgba(0,0,0,.18);border-radius:12px;padding:9px;">
        <div style="font-size:11px;color:#9ca3af;">Aktuális kumulált index</div>
        <div style="font-size:22px;font-weight:900;color:${latest.cumulative_score < 0 ? "#fca5a5" : latest.cumulative_score > 0 ? "#86efac" : "#cbd5e1"};">
          ${formatScore(latest.cumulative_score)}
        </div>
      </div>
      <div style="background:rgba(0,0,0,.18);border-radius:12px;padding:9px;">
        <div style="font-size:11px;color:#9ca3af;">Legutóbbi napi index</div>
        <div style="font-size:22px;font-weight:900;color:${latest.daily_score < 0 ? "#fca5a5" : latest.daily_score > 0 ? "#86efac" : "#cbd5e1"};">
          ${formatScore(latest.daily_score)}
        </div>
      </div>
    </div>
    <p style="margin:9px 0 0;color:#cbd5e1;font-size:11.5px;line-height:1.45;">${trendText}</p>
    <p style="margin:7px 0 0;color:#9ca3af;font-size:11px;line-height:1.45;">
      Legnegatívabb nap: <strong>${worst.date}</strong> (${formatScore(worst.daily_score)}).
      Legpozitívabb nap: <strong>${best.date}</strong> (${formatScore(best.daily_score)}).
    </p>
  `;
}

function renderNewsScoreChart(processedData) {
  const canvas = document.getElementById("newsScoreChart");

  if (!canvas) {
    console.warn("A newsScoreChart azonosítójú canvas nem található.");
    return;
  }

  if (newsScoreChartInstance) {
    newsScoreChartInstance.destroy();
  }

  const labels = processedData.map((day) => day.date);
  const dailyScores = processedData.map((day) => day.daily_score);
  const cumulativeScores = processedData.map((day) => day.cumulative_score);

  const barColors = dailyScores.map(getBarColor);
  const barBorderColors = dailyScores.map(getBarBorderColor);

  newsScoreChartInstance = new Chart(canvas, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        {
          type: "bar",
          label: "Napi hírindex",
          data: dailyScores,
          yAxisID: "y",
          backgroundColor: barColors,
          borderColor: barBorderColors,
          borderWidth: 1,
          borderRadius: 6
        },
        {
          type: "line",
          label: "Kumulált ügyindex",
          data: cumulativeScores,
          yAxisID: "y",
          borderColor: "rgba(147, 197, 253, 1)",
          backgroundColor: "rgba(147, 197, 253, 0.18)",
          tension: 0.25,
          borderWidth: 2,
          pointRadius: 4,
          pointHoverRadius: 6,
          pointBackgroundColor: "rgba(191, 219, 254, 1)",
          pointBorderColor: "rgba(30, 64, 175, 1)"
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false
      },
      plugins: {
        title: {
          display: false
        },
        subtitle: {
          display: false
        },
        legend: {
          display: true,
          labels: {
            color: "#e5e7eb",
            boxWidth: 12,
            font: {
              size: 11
            }
          }
        },
        tooltip: {
          backgroundColor: "rgba(15, 23, 42, 0.96)",
          titleColor: "#f9fafb",
          bodyColor: "#e5e7eb",
          borderColor: "rgba(255,255,255,.18)",
          borderWidth: 1,
          padding: 10,
          displayColors: true,
          callbacks: {
            title: function (context) {
              const index = context[0].dataIndex;
              return processedData[index].date;
            },
            afterBody: function (context) {
              const index = context[0].dataIndex;
              const day = processedData[index];
              return createTooltipLines(day);
            }
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: "#cbd5e1",
            maxRotation: 45,
            minRotation: 0,
            font: {
              size: 10
            }
          },
          grid: {
            color: "rgba(148, 163, 184, 0.12)"
          },
          title: {
            display: true,
            text: "Dátum",
            color: "#9ca3af"
          }
        },
        y: {
          ticks: {
            color: "#cbd5e1",
            font: {
              size: 10
            }
          },
          grid: {
            color: function (context) {
              if (context.tick.value === 0) {
                return "rgba(248, 250, 252, 0.45)";
              }

              return "rgba(148, 163, 184, 0.14)";
            },
            lineWidth: function (context) {
              if (context.tick.value === 0) {
                return 2;
              }

              return 1;
            }
          },
          title: {
            display: true,
            text: "Indexérték",
            color: "#9ca3af"
          }
        }
      }
    }
  });

  createScoreSummary(processedData);
}

async function initNewsScoreChart() {
  try {
    const rawData = await loadNewsScores();

    if (!rawData.items || !Array.isArray(rawData.items)) {
      throw new Error("A news_scores.json nem tartalmaz érvényes items tömböt.");
    }

    const dailyData = groupScoresByDate(rawData.items);
    const processedData = addCumulativeScores(dailyData);

    renderNewsScoreChart(processedData);
  } catch (error) {
    console.error("Hiba az ügyindex diagram betöltésekor:", error);

    const container = document.getElementById("newsScoreChartContainer");

    if (container) {
      container.innerHTML = `
        <h2>Azbeszt Ügyindex</h2>
        <p style="color:#fca5a5;font-weight:700;font-size:12px;line-height:1.45;">
          Nem sikerült betölteni az Azbeszt Ügyindex diagramot.
          Ellenőrizd, hogy létezik-e a <code>data/news_scores.json</code> fájl.
        </p>
      `;
    }
  }
}

document.addEventListener("DOMContentLoaded", initNewsScoreChart);
