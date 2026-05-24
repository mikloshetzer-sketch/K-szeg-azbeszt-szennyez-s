import json
import re
from pathlib import Path

import pandas as pd
import requests


SOURCE_URL = "https://www.martinkepviselo.hu/azbesztveszely/kozerdekulista"

ROOT = Path(__file__).resolve().parents[1]
DATA_DIR = ROOT / "data"
DOCS_DATA_DIR = ROOT / "docs" / "data"

DATA_DIR.mkdir(parents=True, exist_ok=True)
DOCS_DATA_DIR.mkdir(parents=True, exist_ok=True)


def clean_text(value):
    if pd.isna(value):
        return ""
    return re.sub(r"\s+", " ", str(value)).strip()


def normalize_columns(df):
    df = df.copy()
    df.columns = [clean_text(c) for c in df.columns]

    rename_map = {}

    for col in df.columns:
        low = col.lower()

        if low in ["év", "ev", "year"]:
            rename_map[col] = "year"
        elif low in ["hó", "ho", "month"]:
            rename_map[col] = "month"
        elif "felrakod" in low:
            rename_map[col] = "loading_place"
        elif "kirakod" in low:
            rename_map[col] = "destination"
        elif "menny" in low or "tonna" in low or "kg" in low:
            rename_map[col] = "quantity"

    df = df.rename(columns=rename_map)

    return df


def fetch_tables():
    headers = {
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120 Safari/537.36"
        )
    }

    response = requests.get(SOURCE_URL, headers=headers, timeout=30)
    response.raise_for_status()

    tables = pd.read_html(response.text)

    if not tables:
        raise RuntimeError("Nem találtam HTML táblázatot a forrásoldalon.")

    best = None
    best_score = -1

    for table in tables:
        df = normalize_columns(table)

        cols = set(df.columns)
        score = 0

        if "year" in cols:
            score += 2
        if "month" in cols:
            score += 2
        if "loading_place" in cols:
            score += 2
        if "destination" in cols:
            score += 2
        if "quantity" in cols:
            score += 1

        if len(df) > 10:
            score += 1

        if score > best_score:
            best = df
            best_score = score

    if best is None or best_score < 4:
        raise RuntimeError("Találtam táblázatot, de nem ismertem fel EKÁER-adatként.")

    return best


def add_county_guess(destination):
    """
    Egyszerű első verzió.
    Később ezt érdemes pontos település–megye törzsadattal kiváltani.
    """
    name = clean_text(destination).lower()

    vas = {
        "kőszeg", "koszeg", "bozsok", "szombathely", "sárvár", "sarvar",
        "rum", "bük", "buk", "csepreg", "vasvár", "vasvar", "körmend",
        "kormend", "celldömölk", "celldomolk", "őriszentpéter",
        "oriszentpeter", "répcelak", "repcelak"
    }

    zala = {
        "egervár", "egervar", "zalaegerszeg", "nagykanizsa", "keszthely",
        "zalalövő", "zalalovo", "lenti", "hévíz", "heviz", "zalaszentgrót",
        "zalaszentgrot"
    }

    gyms = {
        "sopron", "győr", "gyor", "mosonmagyaróvár", "mosonmagyarovar",
        "kapuvár", "kapuvar", "csorna", "fertőd", "fertod"
    }

    if name in vas:
        return "Vas"
    if name in zala:
        return "Zala"
    if name in gyms:
        return "Győr-Moson-Sopron"

    return "Ismeretlen"


def main():
    df = fetch_tables()
    df = normalize_columns(df)

    required = ["year", "month", "loading_place", "destination"]
    missing = [col for col in required if col not in df.columns]

    if missing:
        raise RuntimeError(f"Hiányzó kötelező oszlopok: {missing}. Elérhető oszlopok: {list(df.columns)}")

    for col in df.columns:
        df[col] = df[col].map(clean_text)

    df = df[df["year"].astype(str).str.match(r"^\d{4}$", na=False)]
    df["year"] = df["year"].astype(int)

    df["month"] = pd.to_numeric(df["month"], errors="coerce").fillna(0).astype(int)

    df["quarry"] = df["loading_place"].str.upper()
    df["destination"] = df["destination"].map(clean_text)
    df["county_guess"] = df["destination"].map(add_county_guess)

    if "quantity" in df.columns:
        df["quantity_raw"] = df["quantity"]
    else:
        df["quantity_raw"] = ""

    records = df.to_dict(orient="records")

    summary = {
        "source_url": SOURCE_URL,
        "record_count": len(records),
        "year_min": int(df["year"].min()) if len(df) else None,
        "year_max": int(df["year"].max()) if len(df) else None,
        "unique_destinations": int(df["destination"].nunique()),
        "unique_quarries": int(df["quarry"].nunique()),
        "quarries": sorted(df["quarry"].dropna().unique().tolist()),
        "county_destination_counts": (
            df.groupby("county_guess")["destination"]
            .nunique()
            .sort_values(ascending=False)
            .to_dict()
        ),
        "quarry_destination_counts": (
            df.groupby("quarry")["destination"]
            .nunique()
            .sort_values(ascending=False)
            .to_dict()
        ),
        "year_record_counts": (
            df.groupby("year")
            .size()
            .to_dict()
        ),
        "quarry_county_matrix": (
            df.groupby(["quarry", "county_guess"])
            .size()
            .reset_index(name="records")
            .to_dict(orient="records")
        ),
        "top_destinations_by_records": (
            df.groupby("destination")
            .size()
            .sort_values(ascending=False)
            .head(30)
            .to_dict()
        )
    }

    outputs = {
        DATA_DIR / "known_shipments.json": records,
        DOCS_DATA_DIR / "known_shipments.json": records,
        DATA_DIR / "ekaer_dashboard_summary.json": summary,
        DOCS_DATA_DIR / "ekaer_dashboard_summary.json": summary,
    }

    for path, payload in outputs.items():
        path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8"
        )

    print("EKÁER adatletöltés kész.")
    print(f"Rekordok száma: {summary['record_count']}")
    print(f"Egyedi céltelepülések: {summary['unique_destinations']}")
    print(f"Forrásbányák: {', '.join(summary['quarries'])}")


if __name__ == "__main__":
    main()
