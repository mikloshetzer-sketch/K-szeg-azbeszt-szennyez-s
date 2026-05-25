import json
import re
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[1]
SOURCE_DIR = ROOT / "data" / "source"

OUTPUTS = [
    ROOT / "data" / "road_projects.json",
    ROOT / "docs" / "data" / "road_projects.json",
]

FLAGGED_STREETS = {
    "BOROSTYÁNKŐ UTCA", "LÉKAI ÚT", "MALOMÁROK UTCA", "MESKÓ UTCA",
    "KÁLVÁRIA UTCA", "BECHTOLD UTCA", "KIRÁLYVÖLGYI UTCA", "ERDŐ UTCA",
    "MÉLYÚT UTCA", "ARBORÉTUM UTCA", "FREH ALFONZ UTCA", "SZENT ANNA UTCA",
    "HADIK UTCA", "ÓHÁZ UTCA", "BERSEK JÓZSEF UTCA", "KÓRHÁZ UTCA",
    "SZENT GYÖRGY UTCA", "JÓZSEF FORRÁS UTCA", "CSŐSZHÁZ UTCA",
    "SZELESTEY LÁSZLÓ UTCA", "HERMINA UTCA", "FEHÉR SÁFRÁNY UTCA",
    "DR AMBRÓ GYULA UTCA", "KENYÉRHEGYI ÚT", "ZRÍNYI UTCA", "SÖRGYÁR UTCA",
    "VÍZMŰ UTCA", "LÓRÁNT GYULA UTCA", "POSZTÓGYÁR UTCA",
    "FORINTOS MÁTYÁS UTCA", "NAPSUGÁR UTCA", "KANKALIN UTCA",
    "TÜSKEVÁR UTCA", "FALUDI UTCA", "HUNYADI UTCA", "RÓMER FLÓRIS UTCA",
    "TÁNCSICS MIHÁLY UTCA", "SÁNCÁROK UTCA", "VÁMHÁZ UTCA",
    "POCICHTER UTCA", "LIBASZŐLŐ UTCA", "HIDEGVÖLGY ÚT", "PANORÁMA KÖRÚT",
    "STRAND SÉTÁNY", "KÁROLYI MIHÁLY UTCA", "LISZT FERENC UTCA",
    "DÓZSA GYÖRGY UTCA", "BAJCSY-ZSILINSZKY UTCA", "RŐTIVÖLGYI UTCA",
}


def clean(value):
    if value is None:
        return ""

    if isinstance(value, pd.Series):
        vals = [str(v).strip() for v in value.tolist() if not pd.isna(v) and str(v).strip()]
        return vals[0] if vals else ""

    if pd.isna(value):
        return ""

    return re.sub(r"\s+", " ", str(value)).strip()


def norm(value):
    text = clean(value).upper()
    text = text.replace(".", "")
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def parse_number(value):
    text = clean(value)
    if not text:
        return 0.0

    text = text.replace("\u00a0", "")
    text = text.replace(" ", "")
    text = text.replace("Ft", "")
    text = text.replace("HUF", "")
    text = text.replace(",", ".")

    match = re.search(r"-?\d+(\.\d+)?", text)
    return float(match.group(0)) if match else 0.0


def parse_year(value):
    text = clean(value)
    match = re.search(r"(20\d{2}|19\d{2})", text)
    return int(match.group(1)) if match else None


def find_excel_file():
    preferred = SOURCE_DIR / "koszeg_ut_es_utcafelujitasok_2015_tol.xlsx"

    if preferred.exists():
        return preferred

    candidates = list(SOURCE_DIR.glob("*.xlsx"))

    if not candidates:
        raise FileNotFoundError(
            f"Nincs Excel fájl itt: {SOURCE_DIR}. "
            "Töltsd fel ide: data/source/koszeg_ut_es_utcafelujitasok_2015_tol.xlsx"
        )

    return candidates[0]


def choose_column(columns, keywords, exclude_keywords=None):
    exclude_keywords = exclude_keywords or []

    for col in columns:
        low = str(col).lower()

        if any(ex in low for ex in exclude_keywords):
            continue

        if any(k in low for k in keywords):
            return col

    return None


def detect_columns(columns):
    columns = list(columns)

    return {
        "period": choose_column(columns, ["időszak", "idoszak"]),
        "year_start": choose_column(columns, ["év kezdete", "ev kezdete"]),
        "year_end": choose_column(columns, ["év vége", "ev vege"]),
        "street": choose_column(columns, ["utca", "út", "ut", "szakasz", "helyszín", "helyszin"]),
        "project": choose_column(columns, ["projekt típusa", "projekt tipusa", "projekt", "munka", "fejlesztés", "felújítás", "felujitas"]),
        "type": choose_column(columns, ["típus", "tipus", "kategória", "kategoria"]),
        "length_m": choose_column(columns, ["hossz", "méter", "meter", "m)"]),
        "amount_huf": choose_column(columns, ["költség", "koltseg", "összeg", "osszeg", "támogatás", "tamogatas"]),
        "funding": choose_column(columns, ["finanszírozás", "finanszirozas", "azonosító", "azonosito", "program"]),
        "status": choose_column(columns, ["státusz", "status", "állapot", "allapot"]),
        "source_url": choose_column(columns, ["forrás url", "forras url", "url", "link"]),
        "confidence": choose_column(columns, ["adatbiztons", "bizonyosság", "bizonyossag"]),
        "notes": choose_column(columns, ["megjegyzés", "megjegyzes", "note"]),
    }


def read_excel(path):
    print(f"Excel betöltése: {path}")

    sheets = pd.read_excel(path, sheet_name=None, dtype=str)

    best_df = None
    best_sheet = None
    best_score = -1
    best_mapping = None

    for sheet_name, df in sheets.items():
        df = df.dropna(how="all").copy()
        df.columns = [clean(c) for c in df.columns]

        mapping = detect_columns(df.columns)

        score = 0
        for key in ["street", "period", "year_start", "year_end", "project", "length_m", "amount_huf", "funding", "status"]:
            if mapping.get(key):
                score += 1

        score += len(df) / 1000

        print(f"Sheet: {sheet_name}, sorok: {len(df)}, pontszám: {score}, mapping: {mapping}")

        if score > best_score:
            best_score = score
            best_df = df
            best_sheet = sheet_name
            best_mapping = mapping

    if best_df is None or best_df.empty:
        raise RuntimeError("Nem sikerült értelmezhető sheetet találni az Excelben.")

    print(f"Kiválasztott sheet: {best_sheet}")
    print(f"Kiválasztott mapping: {best_mapping}")

    return best_df, best_sheet, best_mapping


def cell(row, mapping, key):
    col = mapping.get(key)
    if not col:
        return ""
    return clean(row.get(col, ""))


def is_flagged_street(street):
    street_norm = norm(street)

    if not street_norm:
        return False

    if street_norm in FLAGGED_STREETS:
        return True

    for flagged in FLAGGED_STREETS:
        if flagged in street_norm or street_norm in flagged:
            return True

    return False


def main():
    excel_path = find_excel_file()
    df, sheet_name, mapping = read_excel(excel_path)

    records = []

    for _, row in df.iterrows():
        street = cell(row, mapping, "street")
        if not street:
            continue

        year = parse_year(cell(row, mapping, "year_start"))
        if year is None:
            year = parse_year(cell(row, mapping, "period"))

        year_end = parse_year(cell(row, mapping, "year_end"))

        record = {
            "year": year,
            "year_end": year_end,
            "period": cell(row, mapping, "period"),
            "street": street,
            "street_key": norm(street),
            "project": cell(row, mapping, "project"),
            "type": cell(row, mapping, "type") or cell(row, mapping, "project"),
            "length_m": parse_number(cell(row, mapping, "length_m")),
            "funding": cell(row, mapping, "funding"),
            "amount_huf": parse_number(cell(row, mapping, "amount_huf")),
            "status": cell(row, mapping, "status"),
            "source_url": cell(row, mapping, "source_url"),
            "confidence": cell(row, mapping, "confidence"),
            "notes": cell(row, mapping, "notes"),
        }

        record["flagged_asbestos_street"] = is_flagged_street(record["street"])
        records.append(record)

    unique_streets = sorted({r["street_key"] for r in records if r["street_key"]})
    flagged_records = [r for r in records if r["flagged_asbestos_street"]]
    flagged_streets = sorted({r["street_key"] for r in flagged_records})
    years = [r["year"] for r in records if isinstance(r["year"], int)]

    def group_count(field):
        result = {}
        for r in records:
            key = r.get(field) or "Ismeretlen"
            result[key] = result.get(key, 0) + 1
        return dict(sorted(result.items(), key=lambda x: x[1], reverse=True))

    def group_sum(field, value_field):
        result = {}
        for r in records:
            key = r.get(field) or "Ismeretlen"
            result[key] = result.get(key, 0) + float(r.get(value_field) or 0)
        return dict(sorted(result.items(), key=lambda x: x[1], reverse=True))

    year_project_counts = {}
    year_length_totals = {}
    year_amount_totals = {}
    year_flagged_counts = {}

    for r in records:
        y = str(r["year"]) if r["year"] else "Ismeretlen"

        year_project_counts[y] = year_project_counts.get(y, 0) + 1
        year_length_totals[y] = year_length_totals.get(y, 0) + float(r["length_m"] or 0)
        year_amount_totals[y] = year_amount_totals.get(y, 0) + float(r["amount_huf"] or 0)

        if r["flagged_asbestos_street"]:
            year_flagged_counts[y] = year_flagged_counts.get(y, 0) + 1

    top_projects_by_amount = sorted(
        records,
        key=lambda r: float(r.get("amount_huf") or 0),
        reverse=True
    )[:15]

    top_projects_by_length = sorted(
        records,
        key=lambda r: float(r.get("length_m") or 0),
        reverse=True
    )[:15]

    summary = {
        "title": "Kőszeg út és utca felújítások",
        "source_excel": str(excel_path.relative_to(ROOT)),
        "source_sheet": sheet_name,
        "column_mapping": {k: str(v) for k, v in mapping.items() if v},

        "record_count": len(records),
        "unique_streets": len(unique_streets),
        "year_min": min(years) if years else None,
        "year_max": max(years) if years else None,

        "total_length_m": sum(float(r["length_m"] or 0) for r in records),
        "total_length_km": sum(float(r["length_m"] or 0) for r in records) / 1000,
        "total_amount_huf": sum(float(r["amount_huf"] or 0) for r in records),

        "flagged_record_count": len(flagged_records),
        "flagged_street_count": len(flagged_streets),
        "flagged_streets": flagged_streets,

        "funding_counts": group_count("funding"),
        "funding_amount_totals": group_sum("funding", "amount_huf"),
        "type_counts": group_count("type"),
        "status_counts": group_count("status"),

        "year_project_counts": dict(sorted(year_project_counts.items())),
        "year_length_totals": dict(sorted(year_length_totals.items())),
        "year_amount_totals": dict(sorted(year_amount_totals.items())),
        "year_flagged_counts": dict(sorted(year_flagged_counts.items())),

        "top_projects_by_amount": top_projects_by_amount,
        "top_projects_by_length": top_projects_by_length,

        "records": records,

        "method_note": (
            "Az út- és utcafelújítási adatok a feltöltött Excel-táblából készültek. "
            "Az azbesztügyben megjelölt utcák jelölése névegyezésen és normalizált utcanév-illesztésen alapul. "
            "A jelölés nem bizonyít szennyezést, csak azt mutatja, hogy az adott utcanév szerepel az összevetési listában."
        )
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
    print(f"Összes hossz km: {summary['total_length_km']}")
    print(f"Összes összeg Ft: {summary['total_amount_huf']}")
    print(f"Azbesztlistán szereplő rekordok: {summary['flagged_record_count']}")
    print(f"Azbesztlistán szereplő utcák: {summary['flagged_street_count']}")


if __name__ == "__main__":
    main()
