const fs = require("fs");
const path = require("path");
const pdf = require("pdf-parse");

const INPUT_FILE = path.join(
  __dirname,
  "..",
  "data",
  "greenpeace",
  "greenpeace-factsheet.pdf"
);

const OUTPUT_DIR = path.join(
  __dirname,
  "..",
  "data",
  "greenpeace"
);

const OUTPUT_FILE = path.join(
  OUTPUT_DIR,
  "greenpeace-report-summary.json"
);

const KEYWORDS = [
  "Asbest",
  "asbestos",
  "Asbestbelastung",
  "Asbestalarm",
  "Asbestfasern",
  "Serpentinit",
  "serpentinite",
  "Serpentingestein",
  "Bernstein",
  "Pilgersdorf",
  "Rumpersdorf",
  "Burgenland",
  "Steinbruch",
  "Steinbrüche",
  "Schotter",
  "Splitt",
  "Kies",
  "Export",
  "Ungarn",
  "Hungary",
  "Österreich",
  "Austria",
  "Probe",
  "Proben",
  "Messung",
  "Messungen",
  "Labor",
  "Fasern",
  "Luftmessung",
  "Materialprobe",
  "Grenzwert",
  "Gesundheitsgefahr"
];

const QUARRIES = [
  "Bernstein",
  "Pilgersdorf",
  "Rumpersdorf"
];

function extractSentences(text) {
  return text
    .replace(/\r/g, " ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
}

function findKeywordMatches(sentences) {
  const matches = [];

  for (const sentence of sentences) {
    const foundKeywords = KEYWORDS.filter((keyword) =>
      sentence.toLowerCase().includes(keyword.toLowerCase())
    );

    if (foundKeywords.length > 0) {
      matches.push({
        text: sentence,
        keywords: foundKeywords
      });
    }
  }

  return matches;
}

function buildKeywordStats(matches) {
  const stats = {};

  for (const match of matches) {
    for (const keyword of match.keywords) {
      stats[keyword] = (stats[keyword] || 0) + 1;
    }
  }

  return Object.fromEntries(
    Object.entries(stats).sort((a, b) => b[1] - a[1])
  );
}

function buildQuarryMentions(matches) {
  return QUARRIES.map((quarry) => {
    const relatedMatches = matches.filter((match) =>
      match.text.toLowerCase().includes(quarry.toLowerCase())
    );

    return {
      quarry,
      mention_count: relatedMatches.length,
      related_sentences: relatedMatches.slice(0, 20)
    };
  });
}

async function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    throw new Error(`Nem találom a PDF fájlt: ${INPUT_FILE}`);
  }

  const pdfBuffer = fs.readFileSync(INPUT_FILE);

  console.log("PDF feldolgozása...");

  const data = await pdf(pdfBuffer);

  const text = data.text;

  const sentences = extractSentences(text);

  const matches = findKeywordMatches(sentences);

  const summary = {
    generated_at: new Date().toISOString(),
    source_file: path.basename(INPUT_FILE),
    total_pages: data.numpages,
    total_sentences: sentences.length,
    total_matches: matches.length,
    keyword_stats: buildKeywordStats(matches),
    quarry_mentions: buildQuarryMentions(matches),
    important_matches: matches.slice(0, 500)
  };

  fs.mkdirSync(OUTPUT_DIR, {
    recursive: true
  });

  fs.writeFileSync(
    OUTPUT_FILE,
    JSON.stringify(summary, null, 2),
    "utf8"
  );

  console.log(`Kész: ${OUTPUT_FILE}`);
  console.log(`Oldalak: ${data.numpages}`);
  console.log(`Mondatok: ${sentences.length}`);
  console.log(`Találatok: ${matches.length}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
