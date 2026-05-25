import json
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]

EXCEL_FILE = ROOT / "koszeg_ut_es_utcafelujitasok_2015_tol(1).xlsx"

OUTPUTS = [
    ROOT / "data" / "road_projects.json",
    ROOT / "docs" / "data" / "road_projects.json",
]


def clean(value):
    if pd.isna(value):
        return None

    value = str(value).strip()

    if value == "":
        return None

    return value


def number(value):
    if pd.isna(value):
        return None

    text = str(value).replace(" ", "").replace(",", ".")

    try:
        return float(text)
    except Exception:
        return clean(value)


def detect_columns(columns):
    mapping = {}

    for col in columns:

        low = str(col).lower()

        if "év" in low or "year" in low:
            mapping[col] = "year"

        elif "utca" in low or "út" in low:
            mapping[col] = "street"

        elif "projekt" in low:
            mapping[col] = "project"

        elif "hossz" in low or "méter" in low:
            mapping[col] = "length_m"

        elif "forrás" in low or "program" in low:
            mapping[col] = "funding"

        elif "összeg" in low or "támogatás" in low:
            mapping[col] = "amount_huf"

        elif "státusz" in low:
            mapping[col] = "status"

        elif "megjegyzés" in low:
            mapping[col] = "notes"

    return mapping


def main():

    print("Excel betöltése...")
    df = pd.read_excel(EXCEL_FILE)

    print("Oszlopok:")
    print(list(df.columns))

    mapping = detect_columns(df.columns)

    print("Felismerések:")
    print(mapping)

    df = df.rename(columns=mapping)

    records = []

    for _, row in df.iterrows():

        record = {
            "year": clean(row.get("year")),
            "street": clean(row.get("street")),
            "project": clean(row.get("project")),
            "length_m": number(row.get("length_m")),
            "funding": clean(row.get("funding")),
            "amount_huf": number(row.get("amount_huf")),
            "status": clean(row.get("status")),
            "notes": clean(row.get("notes")),
        }

        if not record["street"]:
            continue

        records.append(record)

    summary = {
        "record_count": len(records),
        "unique_streets": len(
            set(r["street"] for r in records if r["street"])
        ),
        "year_min": min(
            [int(r["year"]) for r in records if r["year"] and str(r["year"]).isdigit()],
            default=None
        ),
        "year_max": max(
            [int(r["year"]) for r in records if r["year"] and str(r["year"]).isdigit()],
            default=None
        ),
        "records": records
    }

    for output in OUTPUTS:

        output.parent.mkdir(parents=True, exist_ok=True)

        output.write_text(
            json.dumps(summary, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )

        print(f"Mentve: {output}")

    print("Kész.")
    print(f"Rekordok: {summary['record_count']}")
    print(f"Egyedi utcák: {summary['unique_streets']}")


if __name__ == "__main__":
    main()
