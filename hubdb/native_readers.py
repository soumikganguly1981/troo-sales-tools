"""native_readers.py - readers for supplier price files that are NOT in the standard UD upload template.

Each reader returns a pandas DataFrame in one common shape (NORMAL_COLS), one row per price line:
  supplier, fuel (E/G), contract_type (ACQ/REN), region (electricity: DNO/PES id 10-23; gas: LDZ code),
  exit_zone (gas), product, rate_type, profile, ssc, band, aq_min, aq_max, term (months),
  start_from, start_to (contract start window, YYYY-MM-DD), end_date (fixed contract end, if given),
  unit, day, night, ew, weekday, winter_eve (p/kWh), sc_p_day, green, source_file

Formats covered (Nov 2026 samples):
  flatfile_pow  20261124_POW_<ACQ|REN>_R[_ECO].csv   (supplier set by the caller: not in the file)
  flatfile_gas  20261124_GAS_<ACQ|REN>_P_UR.csv      (supplier set by the caller: not in the file)
  edf_kraken    rate_card_<ddmmyy>_EDFKraken.csv
  bgl_tool      BGL VB Elec & Gas Quote Tool ... .xlsb (sheets "Prices" and "Prices Elec")
"""
import os
import re
from datetime import date, timedelta

import numpy as np
import pandas as pd

NORMAL_COLS = ["supplier", "fuel", "contract_type", "region", "exit_zone", "product", "rate_type", "profile", "ssc",
               "band", "aq_min", "aq_max", "term", "start_from", "start_to", "end_date", "unit", "day", "night", "ew",
               "weekday", "winter_eve", "sc_p_day", "green", "source_file"]
RATE_COLS = ["unit", "day", "night", "ew", "weekday", "winter_eve"]


def _finish(df, source):
    df = df.copy()
    df["source_file"] = os.path.basename(source)
    for c in NORMAL_COLS:
        if c not in df.columns:
            df[c] = None
    df = df[NORMAL_COLS]
    for c in RATE_COLS + ["sc_p_day", "aq_min", "aq_max", "term"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    df[RATE_COLS] = df[RATE_COLS].where(df[RATE_COLS] > 0)  # 0 means "no rate on this line"
    if (df["fuel"] == "E").any():
        df = _structure(df)
    return df.reset_index(drop=True)


# Rates present on a line -> the loader's rate_type (single / daynight / ew / ewn as in UD files).
# A weekday-day rate is the day rate of an evening-and-weekend meter. Structures the Matrix card can't
# price yet get their own rate_type so they never match an ordinary meter.
STRUCTURES = {("unit",): "single", ("day", "night"): "daynight", ("day", "ew"): "ew", ("day", "night", "ew"): "ewn",
              ("night",): "night_only", ("ew", "winter_eve"): "ew_winter", ("day", "night", "winter_eve"): "daynight_winter"}


def _structure(df):
    e = df["fuel"] == "E"
    move = e & df["day"].isna() & df["weekday"].notna()
    df.loc[move, "day"] = df.loc[move, "weekday"]
    df.loc[move, "weekday"] = np.nan
    present = df[RATE_COLS].notna()
    key = present.apply(lambda r: tuple(c for c in RATE_COLS if r[c]), axis=1)
    df.loc[e, "rate_type"] = key[e].map(lambda k: STRUCTURES.get(k))
    unknown = e & df["rate_type"].isna()
    if unknown.any():
        raise ValueError(f"{unknown.sum()} rows with an unrecognised mix of rates: {sorted(set(key[unknown]))[:5]}")
    return df


def _window(starts, months_after_last):
    """Contract start dates come as a list (VALID_FROM). Each runs until the day before the next one."""
    days = sorted(set(starts))
    nxt = {d: (pd.Timestamp(days[i + 1]) if i + 1 < len(days) else pd.Timestamp(d) + pd.DateOffset(months=months_after_last))
           - pd.Timedelta(days=1) for i, d in enumerate(days)}
    return [nxt[d].strftime("%Y-%m-%d") for d in starts]


def detect(name):
    """Return the reader key for a file name, or None if it isn't one of these native formats."""
    n = os.path.basename(name)
    if re.search(r"(^|_)\d{8}_POW_(ACQ|REN)_", n, re.I) and n.lower().endswith(".csv"):
        return "flatfile_pow"
    if re.search(r"(^|_)\d{8}_GAS_(ACQ|REN)_", n, re.I) and n.lower().endswith(".csv"):
        return "flatfile_gas"
    if re.search(r"edfkraken", n, re.I) and n.lower().endswith(".csv"):
        return "edf_kraken"
    if re.match(r"^BGL", n, re.I) and n.lower().endswith(".xlsb"):
        return "bgl_tool"
    return None


# ---------------------------------------------------------------- 20261124 flat files (supplier not in file)
def _ctype(name):
    m = re.search(r"_(ACQ|REN)_", os.path.basename(name), re.I)
    return m.group(1).upper() if m else "ANY"


def read_flatfile_pow(path, supplier, sc_unit="p_day"):
    """Power flat file. sc_unit: 'p_day' or 'gbp_year' (STANDING_CHARGE unit is not stated in the file)."""
    df = pd.read_csv(path, dtype=str)
    out = pd.DataFrame({
        "supplier": supplier, "fuel": "E", "contract_type": _ctype(path),
        "region": pd.to_numeric(df["DIST_ID"]).astype(int),
        "product": df["PRODUCT_NAME"],
        "profile": pd.to_numeric(df["PC"]).astype(int).astype(str).str.zfill(2),
        "ssc": df["SSC"],
        "band": df["PRODUCT_NAME"].str.extract(r"\bB(\d)\b", expand=False),
        "aq_min": df["MIN_CONS"], "aq_max": df["MAX_CONS"], "term": df["CONTRACT_LENGTH"],
        "start_from": df["VALID_FROM"], "start_to": _window(df["VALID_FROM"].tolist(), 3),
        "unit": df["UNITS"], "day": df["DAY_UNITS"], "night": df["NIGHT_UNITS"], "ew": df["EVE_WE_UNITS"],
        "weekday": df["WEEKDAY_UNITS"], "winter_eve": df["WINTER_EVE"],
        "sc_p_day": pd.to_numeric(df["STANDING_CHARGE"]) * (100 / 365 if sc_unit == "gbp_year" else 1),
        "green": df["PRODUCT_NAME"].str.startswith("ECO_"),
    })
    return _finish(out, path)


def read_flatfile_gas(path, supplier):
    df = pd.read_csv(path, dtype=str)
    out = pd.DataFrame({
        "supplier": supplier, "fuel": "G", "contract_type": _ctype(path),
        "region": df["REGION"].str.extract(r"^([A-Z]+)", expand=False), "exit_zone": df["REGION"],
        "product": df["PRODUCT_NAME"], "rate_type": "single",
        "aq_min": df["AQ_MIN"], "aq_max": df["AQ_MAX"], "term": df["CONTRACT_LENGTH"],
        "start_from": df["VALID_FROM"], "start_to": _window(df["VALID_FROM"].tolist(), 1),
        "unit": df["FINAL_PRICE"], "sc_p_day": df["STANDING_CHARGE"], "green": False,
    })
    return _finish(out, path)


# ---------------------------------------------------------------- EDF (Kraken rate card)
# EDF prices gas by electricity region (DNO id). Nearest gas LDZ for each - approximate where they don't line up.
DNO_TO_LDZ = {"10": "EA", "11": "EM", "12": "NT", "13": "WN", "14": "WM", "15": "NO", "16": "NW", "17": "SC",
              "18": "SC", "19": "SE", "20": "SO", "21": "WS", "22": "SW", "23": "NE"}


def read_edf_kraken(path, today=None):
    """Start window comes from Min/Max Selling Days, counted from the quote date (today by default)."""
    today = today or date.today()
    df = pd.read_csv(path, dtype=str)
    gas = df["Utility"].str.upper().eq("GAS")
    rs = df["RateStructure"].str.upper()
    single = rs.eq("STANDARD") | gas
    day = pd.to_numeric(df["DayRate"]); unit_col = pd.to_numeric(df["UnitRate"])
    sd = lambda col: [(today + timedelta(days=int(x))).isoformat() for x in pd.to_numeric(df[col]).fillna(0)]
    out = pd.DataFrame({
        "supplier": "EDF Energy", "fuel": np.where(gas, "G", "E"),
        "contract_type": df["SaleType"].str[:3].str.upper().map({"ACQ": "ACQ", "REN": "REN"}),
        "region": np.where(gas, df["DnoId"].map(DNO_TO_LDZ), df["DnoId"]),
        "product": df["TariffInformation2"] + np.where(df["StandingChargeType"].str.upper().eq("NSC"), " (no standing charge)", ""),
        "rate_type": "single",
        "aq_min": df["MinimumAnnualConsumption"], "aq_max": df["MaximumAnnualConsumption"], "term": df["ContractDuration"],
        "start_from": sd("Min Selling Days"), "start_to": sd("Max Selling Days"),
        "unit": np.where(single, np.where(unit_col > 0, unit_col, day), np.nan),
        "day": np.where(single, np.nan, day), "night": df["NightRate"], "ew": df["EveningWeekendRate"],
        "sc_p_day": df["StandingCharge"], "green": df["GreenEnergy"].eq("1"),
    })
    return _finish(out, path)


# ---------------------------------------------------------------- BG Lite quote tool (.xlsb)
def _xlsb_sheet(path, name):
    from pyxlsb import open_workbook
    with open_workbook(path) as wb, wb.get_sheet(name) as sh:
        rows = [[c.v for c in r] for r in sh.rows()]
    hdr = [str(h).strip() if h is not None else f"_{i}" for i, h in enumerate(rows[0])]
    body = [(r + [None] * len(hdr))[:len(hdr)] for r in rows[1:]]
    return pd.DataFrame(body, columns=hdr).dropna(how="all")


def _excel_date(v):
    return (date(1899, 12, 30) + timedelta(days=int(v))).isoformat()


def _bands(upper):
    """Consumption Range holds the band's upper limit; the lower limit is the previous band's upper + 1."""
    ups = sorted(set(upper))
    lo = {u: (ups[i - 1] + 1 if i else 0) for i, u in enumerate(ups)}
    return [lo[u] for u in upper]


BGL_ELEC_LINE = {"UNIT CHARGE": "unit", "DAY UNIT CHARGE": "day", "NIGHT UNIT CHARGE": "night",
                 "EVENING & WEEKEND UNIT CHARGE": "ew", "WEEKDAY DAY UNIT CHARGE": "weekday", "Standing Charge": "sc_p_day"}


def read_bgl_tool(path):
    out = []
    g = _xlsb_sheet(path, "Prices")
    g = g[g["Price Line Description"].notna()]
    keys = ["Window Open", "Window Close", "Exit Zone", "LDZ / PES Region", "Sales Type", "Contract Duration", "Consumption Range"]
    gp = g.pivot_table(index=keys, columns="Price Line Description", values="Unit Charge", aggfunc="first").reset_index()
    out.append(pd.DataFrame({
        "supplier": "BG Lite", "fuel": "G", "contract_type": gp["Sales Type"].str[:3].str.upper(),
        "region": gp["LDZ / PES Region"], "exit_zone": gp["Exit Zone"], "product": "BG Lite VB", "rate_type": "single",
        "aq_min": _bands(gp["Consumption Range"].tolist()), "aq_max": gp["Consumption Range"], "term": gp["Contract Duration"],
        "start_from": gp["Window Open"].map(_excel_date), "start_to": gp["Window Close"].map(_excel_date),
        "unit": gp.get("Gas Unit Charge"), "sc_p_day": gp.get("Standing Charge"), "green": False,
    }))
    e = _xlsb_sheet(path, "Prices Elec")
    e = e[e["Price Line Description"].notna()]
    keys = ["Window Open", "Window Close", "Region (PES)", "Profile Class", "Meter Type", "Sales Type", "Contract Duration",
            "Consumption Range", "DUoS Band"]
    ep = e.pivot_table(index=keys, columns="Price Line Description", values="Unit Charge", aggfunc="first").reset_index()
    ep = ep.rename(columns=BGL_ELEC_LINE)
    out.append(pd.DataFrame({
        "supplier": "BG Lite", "fuel": "E", "contract_type": ep["Sales Type"].str[:3].str.upper(),
        "region": ep["Region (PES)"].astype(int), "product": "BG Lite VB",
        "profile": ep["Profile Class"].astype(int).astype(str).str.zfill(2), "band": ep["DUoS Band"].str.extract(r"(\d)\s*$", expand=False),
        "aq_min": _bands(ep["Consumption Range"].tolist()), "aq_max": ep["Consumption Range"], "term": ep["Contract Duration"],
        "start_from": ep["Window Open"].map(_excel_date), "start_to": ep["Window Close"].map(_excel_date),
        **{c: ep.get(c) for c in ["unit", "day", "night", "ew", "weekday", "sc_p_day"]}, "green": False,
    }))
    return _finish(pd.concat(out, ignore_index=True), path)


def read(path, supplier=None, sc_unit="p_day", today=None):
    kind = detect(path)
    if kind == "flatfile_pow":
        if not supplier:
            raise ValueError(f"{os.path.basename(path)}: the supplier isn't in this file; pass supplier=")
        return read_flatfile_pow(path, supplier, sc_unit)
    if kind == "flatfile_gas":
        if not supplier:
            raise ValueError(f"{os.path.basename(path)}: the supplier isn't in this file; pass supplier=")
        return read_flatfile_gas(path, supplier)
    if kind == "edf_kraken":
        return read_edf_kraken(path, today)
    if kind == "bgl_tool":
        return read_bgl_tool(path)
    raise ValueError(f"No native reader for {os.path.basename(path)}")


def problems(df):
    """Basic sanity checks on a normalised frame. Returns a list of strings (empty = OK)."""
    p = []
    has_rate = df[RATE_COLS].notna().any(axis=1)
    if (~has_rate).any():
        p.append(f"{(~has_rate).sum()} rows with no unit rate")
    for c in RATE_COLS:
        s = df[c].dropna()
        if len(s) and (s.min() < 1 or s.max() > 150):
            p.append(f"{c} outside 1-150 p/kWh: {s.min()}..{s.max()}")
    if (df["aq_min"] > df["aq_max"]).any():
        p.append(f"{(df['aq_min'] > df['aq_max']).sum()} rows with aq_min > aq_max")
    if df["term"].isna().any() or (~df["term"].isin([6, 12, 18, 24, 36, 48, 60])).any():
        p.append(f"unexpected terms: {sorted(df['term'].dropna().unique().tolist())}")
    if df["contract_type"].isna().any():
        p.append("rows without ACQ/REN")
    if df["start_from"].isna().any() or (df["start_to"] < df["start_from"]).any():
        p.append("bad contract start windows")
    if df["region"].isna().any():
        p.append(f"{df['region'].isna().sum()} rows without a region")
    return p
