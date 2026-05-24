import json
import re
from io import StringIO
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pandas as pd
import requests
from bs4 import BeautifulSoup


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


def get_html(url):
    r = requests.get(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=40)
    r.raise_for_status()
    return r.text


def extract_iframe_url(html):
    soup = BeautifulSoup(html, "html.parser")
    iframe = soup.find("iframe")

    if not iframe or not iframe.get("src"):
        raise RuntimeError("Nem találtam iframe-et.")

    src = iframe["src"].replace("&amp;", "&")

    if src.startswith("//"):
        src = "https:" + src

    return src


def google_csv_url(sheet_url):
    parsed = urlparse(sheet_url)
    parts = parsed.path.split("/")

    try:
        doc_id = parts[parts.index("d") + 1]
    except Exception as exc:
        raise RuntimeError(f"Nem tudtam kinyerni a Google Sheet azonosítót: {sheet_url}") from exc

    query = parse_qs(parsed.query)
    gid = query.get("gid", ["0"])[0]

    return f"https://docs.google.com/spreadsheets/d/{doc_id}/export?format=csv&gid={gid}"


def normalize_columns(df):
    df = df.copy()
    df.columns = [clean_text(c) for c in df.columns]

    rename = {}

    for col in df.columns:
        low = col.lower()

        if low in ["év", "ev", "year"]:
            rename[col] = "year"
        elif low in ["hó", "ho", "month"]:
            rename[col] = "month"
        elif "felrakod" in low:
            rename[col] = "loading_place"
        elif "kirakod" in low:
            rename[col] = "destination"
        elif "menny" in low or "tonna" in low or "kg" in low:
            rename[col] = "quantity"

    return df.rename(columns=rename)


def fetch_table():
    html = get_html(SOURCE_URL)
    iframe_url = extract_iframe_url(html)
    csv_url = google_csv_url(iframe_url)

    print("Google Sheets iframe URL:", iframe_url)
    print("Google Sheets CSV URL:", csv_url)

    csv_text = get_html(csv_url)

    if "<html" in csv_text[:200].lower():
        raise RuntimeError("A CSV export helyett HTML érkezett. Lehet, hogy a sheet export tiltott.")

    df = pd.read_csv(StringIO(csv_text))
    df = normalize_columns(df)

    return df, iframe_url, csv_url


def add_county_guess(destination):
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
    df, iframe_url, csv_url = fetch_table()

    required = ["year", "month", "loading_place", "destination"]
    missing = [c for c in required if c not in df.columns]

    if missing:
        raise RuntimeError(
            f"Hiányzó oszlopok: {missing}. Elérhető oszlopok: {list(df.columns)}"
        )

    for col in df.columns:
        df[col] = df[col].map(clean_text)

    df = df[df["year"].astype(str).str.match(r"^\d{4}$", na=False)].copy()
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
        "google_sheet_iframe_url": iframe_url,
        "google_sheet_csv_url": csv_url,
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
        path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    print("EKÁER adatletöltés kész.")
    print(f"Rekordok száma: {summary['record_count']}")
    print(f"Egyedi céltelepülések: {summary['unique_destinations']}")
    print(f"Forrásbányák: {', '.join(summary['quarries'])}")


if __name__ == "__main__":
    main()
