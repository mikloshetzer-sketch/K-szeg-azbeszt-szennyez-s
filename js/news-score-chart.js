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
 * Az index nem "hangulatelemzés", hanem esemény-alapú ügyindex.
 */

async function loadNewsScores() {
  const response = await fetch("data/news_scores.json");

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
      cumulative_score: Number(cumulative.toFixed(2)),
      daily_score: Number(day.daily_score.toFixed(2))
    };
  });
}

function createTooltipText(day) {
  const lines = [];

  lines.push(`Dátum: ${day.date}`);
  lines.push(`Napi index: ${day.daily_score}`);
  lines.push(`Kumulált index: ${day.cumulative_score}`);
  lines.push("");
  lines.push("Hírek:");

  day.items.forEach((item) => {
    const score = item.final_score > 0 ? `+${item.final_score}` : item.final_score;
    lines.push(`• ${score} – ${item.title}`);
  });

  return lines;
}

function renderNewsScoreChart(processedData) {
  const canvas = document.getElementById("newsScoreChart");

  if (!canvas) {
    console.warn("A newsScoreChart azonosítójú canvas nem található.");
    return;
  }

  const labels = processedData.map((day) => day.date);
  const dailyScores = processedData.map((day) => day.daily_score);
  const cumulativeScores = processedData.map((day) => day.cumulative_score);

  new Chart(canvas, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        {
          type: "bar",
          label: "Napi hírindex",
          data: dailyScores,
          yAxisID: "y",
          borderWidth: 1
        },
        {
          type: "line",
          label: "Kumulált ügyindex",
          data: cumulativeScores,
          yAxisID: "y",
          tension: 0.25,
          borderWidth: 2,
          pointRadius: 4
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
          display: true,
          text: "Azbeszt Ügyindex – napi híralapú változás"
        },
        subtitle: {
          display: true,
          text: "Negatív érték: romló/kockázatos fejlemény. Pozitív érték: intézkedés vagy megoldás felé mutató esemény."
        },
        legend: {
          display: true
        },
        tooltip: {
          callbacks: {
            afterBody: function (context) {
              const index = context[0].dataIndex;
              const day = processedData[index];
              return createTooltipText(day);
            }
          }
        }
      },
      scales: {
        x: {
          title: {
            display: true,
            text: "Dátum"
          }
        },
        y: {
          title: {
            display: true,
            text: "Indexérték"
          },
          grid: {
            drawBorder: true
          }
        }
      }
    }
  });
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
        <p style="color: #b00020; font-weight: 600;">
          Nem sikerült betölteni az Azbeszt Ügyindex diagramot.
        </p>
      `;
    }
  }
}

document.addEventListener("DOMContentLoaded", initNewsScoreChart);
