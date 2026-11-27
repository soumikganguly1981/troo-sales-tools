"""
load_price_books.py - loads supplier matrix price books into HubSpot for the Matrix prices card.

How it's used
  The Pricing team drops a supplier's price file (.xlsx or .csv, standard "UD" upload template)
  into the HubSpot file manager folder "Price books/Incoming". The GitHub Action
  (.github/workflows/price-books.yml) runs this script every 15 minutes, and on demand:
    1. reads each new file and checks it (columns, row count, rate ranges, dates)
    2. converts it to one JSON book per supplier, fuel, contract type and region
    3. uploads the books as PRIVATE files to "Price books/Live"
    4. adds them to the HubDB table price_books as "live", marks the books they replace "superseded",
       and publishes the table
    5. moves the source file to "Price books/Processed" (or "Price books/Failed" with the reason)

Safe by default: DRY_RUN=true reads and checks files and prints what it would do, writing nothing.
Local test without HubSpot:  python load_price_books.py --local FILE.xlsx [FILE2 ...]  (writes ./out/*.json)

Supplier native formats (native_readers.py) are also accepted, as the supplier sends them:
  <CODE>_20261124_POW_ACQ_R.csv, <CODE>_20261124_GAS_REN_P_UR.csv  flat files: these don't name the supplier,
      so put its code from SUPPLIER_CODES in front of the name, e.g. YU_20261124_POW_ACQ_R.csv
  rate_card_<ddmmyy>_EDFKraken.csv                                 EDF rate card (power and gas, ACQ and REN)
  BGL ... .xlsb                                                    BG Lite quote tool (sheets Prices, Prices Elec)
  One native file can hold several fuels and contract types; each becomes its own set of books.
  These files carry no quote-by date: books are quotable for NATIVE_QUOTE_DAYS (default 7) after the file date.

Credentials, either of:
  HUBSPOT_PERSONAL_ACCESS_KEY (+ HUBSPOT_ACCOUNT_ID): the HubSpot CLI personal access key already used for
    deploys. It is exchanged for a short-lived access token. The key needs the Files and HubDB scopes.
  HUBSPOT_PRICEBOOK_TOKEN: a private app token with the scopes files, hubdb (used if set).
"""
import io, json, os, re, sys, tempfile, time, datetime as dt
import requests
import pandas as pd
import native_readers

DRY_RUN = os.getenv("DRY_RUN", "true").lower() != "false"
TOKEN = os.getenv("HUBSPOT_PRICEBOOK_TOKEN", "")
PAK = os.getenv("HUBSPOT_PERSONAL_ACCESS_KEY", "")
ACCOUNT_ID = os.getenv("HUBSPOT_ACCOUNT_ID", "")
BASE = "https://api.hubapi.com"
TABLE = "price_books"
NATIVE_QUOTE_DAYS = int(os.getenv("NATIVE_QUOTE_DAYS", "7"))
FILE_TYPES = r"\.(xlsx|xls|xlsb|csv)$"
FOLDERS = {"incoming": "/Price books/Incoming", "live": "/Price books/Live",
           "processed": "/Price books/Processed", "failed": "/Price books/Failed"}

# Supplier code in the file name (UD_<broker>_<CODE>_<fuel>_<ACQ|REN>_<ddmmyy>) -> canonical supplier name
# (names as in the HubDB supplier map). Add a line when a new supplier starts sending files.
SUPPLIER_CODES = {
    "YU": "Yu Energy", "BG": "British Gas", "BGL": "BG Lite", "CORONA": "Corona Energy", "COR": "Corona Energy",
    "EDF": "EDF Energy", "TOTAL": "TotalEnergies", "TGP": "TotalEnergies", "VALDA": "Valda Energy",
    "SMARTEST": "Smartest Energy Business", "SEB": "Smartest Energy Business", "CROWN": "Crown Gas & Power",
    "DRAX": "Drax", "ENGIE": "Engie", "NPOWER": "Npower", "SHELL": "Shell Energy", "SEFE": "SEFE Energy",
}

# Book columns, in the order written to each JSON book (all-empty columns are dropped per book)
COLS = ["product", "rate_type", "profile", "band", "voltage", "exit_zone", "aq_min", "aq_max", "term",
        "start_from", "start_to", "unit", "day", "night", "ew", "sc_p_day", "kva_p_kva_month", "green",
        "end_date", "dd", "amr", "credit_min", "credit_max", "mop", "winter_eve", "ssc"]

RATE_STRUCTURES = {"standard": "single", "daynight": "daynight", "eveningandweekend": "ew", "eveningweekendandnight": "ewn"}
VOLTAGES = {"hvhh": "High voltage", "lvhh": "Low voltage", "lvsubhh": "LV substation", "lvnetworknoncthh": "LV network non-CT"}
SANE = {"rate": (1.0, 150.0), "sc": (0.0, 20000.0), "kva": (0.0, 100.0)}  # p/kWh, p/day, p/kVA/month


# ---------------------------------------------------------------- reading a UD template file
def parse_name(name):
    """UD_Soar_YU_ELE_ACQ_241126.xlsx -> ('Yu Energy', 'ACQ'). HH_ prefix is allowed."""
    stem = re.sub(r"\.(xlsx|xls|csv)$", "", os.path.basename(name), flags=re.I)
    parts = [p for p in stem.split("_") if p]
    if parts and parts[0].upper() == "HH":
        parts = parts[1:]
    if len(parts) < 4 or parts[0].upper() != "UD":
        raise ValueError(f"File name '{name}' doesn't follow UD_<broker>_<supplier>_<fuel>_<ACQ|REN>_<ddmmyy>")
    code = parts[2].upper()
    if code not in SUPPLIER_CODES:
        raise ValueError(f"Unknown supplier code '{code}' in '{name}'. Add it to SUPPLIER_CODES in load_price_books.py")
    ctype = next((p.upper() for p in parts[3:] if p.upper() in ("ACQ", "REN")), "ANY")
    return SUPPLIER_CODES[code], ctype


def read_frame(name, data):
    df = pd.read_csv(io.BytesIO(data)) if name.lower().endswith(".csv") else pd.read_excel(io.BytesIO(data))
    df.columns = [str(c).strip().lower() for c in df.columns]
    return df


def iso(v):
    if v is None or (isinstance(v, float) and pd.isna(v)) or v == "":
        return None
    if isinstance(v, (pd.Timestamp, dt.datetime, dt.date)):
        return pd.Timestamp(v).strftime("%Y-%m-%d")
    s = str(v).strip()
    for fmt in ("%d/%m/%Y", "%Y-%m-%d", "%Y-%m-%d %H:%M:%S"):
        try:
            return dt.datetime.strptime(s, fmt).strftime("%Y-%m-%d")
        except ValueError:
            pass
    raise ValueError(f"Unreadable date '{s}'")


def num(v):
    return None if v is None or (isinstance(v, float) and pd.isna(v)) or v == "" else float(v)


def boolish(v):
    if v is None or (isinstance(v, float) and pd.isna(v)) or v == "":
        return None
    return str(v).strip().lower() in ("true", "1", "yes", "y")


def split_band(text, mapping):
    """'DayNight Band 2' -> ('daynight', '2'); 'LVHH Band 1' -> ('Low voltage', '1')"""
    m = re.match(r"^\s*(.+?)\s+band\s+(\d)\s*$", str(text), flags=re.I)
    key, band = (m.group(1), m.group(2)) if m else (str(text), None)
    key = re.sub(r"[^a-z]", "", key.lower())
    if key not in mapping:
        raise ValueError(f"Unknown rate structure / voltage type '{text}'")
    return mapping[key], band


def transform(df):
    """UD template frame -> (fuel, rows as dicts with 'region', quote window, version)."""
    need = {"contractduration", "minimumannualconsumption", "maximumannualconsumption", "minimumcontractstartdate",
            "maximumcontractstartdate", "maximumvalidquotedate", "productname", "standingcharge"}
    missing = need - set(df.columns)
    if missing:
        raise ValueError(f"Missing columns: {', '.join(sorted(missing))}")
    if "voltagetype" in df.columns:
        fuel = "HH"
    elif "utility" in df.columns and df["utility"].astype(str).str.lower().eq("gas").all():
        fuel = "G"
    else:
        fuel = "E"
    rows = []
    for r in df.to_dict("records"):
        g = lambda k: r.get(k)
        out = {c: None for c in COLS}
        out.update({
            "product": str(g("productname")).strip(),
            "aq_min": num(g("minimumannualconsumption")), "aq_max": num(g("maximumannualconsumption")),
            "term": int(num(g("contractduration")) or 0) or None,
            "start_from": iso(g("minimumcontractstartdate")), "start_to": iso(g("maximumcontractstartdate")),
            "green": boolish(g("greenenergy")), "end_date": iso(g("fixedcontractenddate")),
            "dd": None if not g("paymentmethod") or pd.isna(g("paymentmethod")) else str(g("paymentmethod")).lower().startswith("direct"),
            "amr": boolish(g("amr")), "credit_min": num(g("minimumcreditscore")), "credit_max": num(g("maximumcreditscore")),
            "mop": boolish(g("mopinclusive")),
        })
        sc_type = str(g("standingchargetype") or "").strip().lower()
        out["sc_p_day"] = 0.0 if sc_type == "nsc" else num(g("standingcharge"))
        if fuel == "G":
            region = str(g("ldz")).strip().upper()
            out.update({"rate_type": "single", "exit_zone": None if pd.isna(g("exitzone")) else str(g("exitzone")).strip().upper(),
                        "unit": num(g("unitrate"))})
        elif fuel == "HH":
            region = str(int(num(g("dnoid"))))
            out["voltage"], out["band"] = split_band(g("voltagetype"), VOLTAGES)
            out.update({"rate_type": "hh", "day": num(g("dayrate")), "night": num(g("nightrate")),
                        "kva_p_kva_month": num(g("capacitycharge"))})
        else:
            region = str(int(num(g("dnoid"))))
            out["rate_type"], out["band"] = split_band(g("ratestructure"), RATE_STRUCTURES)
            out["profile"] = None if pd.isna(g("profileclass")) else str(int(num(g("profileclass")))).zfill(2)
            day, night, ew, unit = num(g("dayrate")), num(g("nightrate")), num(g("eveningweekendrate")), num(g("unitrate"))
            if out["rate_type"] == "single":
                unit = unit if unit is not None else day  # UD files put the single rate in dayrate
                day = None
            out.update({"unit": unit, "day": day, "night": night, "ew": ew})
        out["region"] = region
        rows.append(out)
    quote_by = max(iso(v) for v in df["maximumvalidquotedate"].dropna())
    valid_from = min(iso(v) for v in df["minimumvalidquotedate"].dropna()) if "minimumvalidquotedate" in df else None
    version = iso(df["version"].dropna().iloc[0]) if "version" in df and df["version"].notna().any() else None
    return fuel, rows, quote_by, valid_from, version


def check(rows, quote_by, today):
    """Returns (errors, notes). Any error stops the file loading."""
    errors, notes = [], []
    if not rows:
        errors.append("No rows")
    lo, hi = SANE["rate"]
    bad = [r for r in rows if any(r[k] is not None and not lo <= r[k] <= hi for k in ("unit", "day", "night", "ew"))]
    if bad:
        errors.append(f"{len(bad)} rows have a unit rate outside {lo}-{hi}p/kWh")
    no_rate = [r for r in rows if all(r[k] is None for k in ("unit", "day", "night", "ew"))]
    if no_rate:
        errors.append(f"{len(no_rate)} rows have no unit rate")
    lo, hi = SANE["sc"]
    if any(r["sc_p_day"] is not None and not lo <= r["sc_p_day"] <= hi for r in rows):
        errors.append(f"Standing charges outside {lo}-{hi}p/day")
    lo, hi = SANE["kva"]
    if any(r["kva_p_kva_month"] is not None and not lo <= r["kva_p_kva_month"] <= hi for r in rows):
        errors.append(f"Capacity charges outside {lo}-{hi}p/kVA/month")
    if any(r["term"] is None and r["end_date"] is None for r in rows):
        errors.append("Rows with neither a contract length nor a fixed end date")
    if quote_by and quote_by < today:
        errors.append(f"Prices could only be quoted until {quote_by}")
    notes.append(f"{len(rows)} rows")
    return errors, notes


def books_from(supplier, ctype, fuel, rows, quote_by, valid_from, version, source):
    by_region = {}
    for r in rows:
        by_region.setdefault(r["region"], []).append(r)
    books = []
    for region, rs in sorted(by_region.items()):
        cols = [c for c in COLS if any(x[c] is not None for x in rs)]
        meta = {"supplier": supplier, "contract_type": ctype, "fuel": fuel, "region": region, "quote_by": quote_by,
                "valid_from": valid_from, "version": version, "source": source, "rows": len(rs)}
        books.append({"meta": meta, "cols": cols, "rows": [[x[c] for c in cols] for x in rs]})
    return books


def book_file_name(b):
    m = b["meta"]
    slug = re.sub(r"[^a-z0-9]+", "-", m["supplier"].lower()).strip("-")
    return f"{slug}_{m['fuel']}_{m['contract_type']}_{m['region']}_{(m['version'] or m['valid_from'] or '').replace('-', '')}_{int(time.time())}.json"


# ---------------------------------------------------------------- HubSpot
H = {"Authorization": f"Bearer {TOKEN}"}
_pak_expires = 0.0


def pak_token():
    """Exchange the CLI personal access key for an access token (what `hs` does)."""
    global _pak_expires
    q = f"?portalId={ACCOUNT_ID}" if ACCOUNT_ID else ""
    r = requests.post(f"{BASE}/localdevauth/v1/auth/refresh{q}",
                      json={"encodedOAuthRefreshToken": PAK}, timeout=60)
    if r.status_code != 200:
        sys.exit(f"Personal access key exchange failed: {r.status_code} {r.text[:300]}")
    j = r.json()
    groups = j.get("scopeGroups") or []
    if groups and not any("hubdb" in g for g in groups):
        print("WARNING: the personal access key has no HubDB scope - regenerate it with HubDB and Files ticked")
    _pak_expires = j.get("expiresAtMillis", 0) / 1000 or time.time() + 1500
    H["Authorization"] = f"Bearer {j['oauthAccessToken']}"


def call(method, path, **kw):
    r = None
    extra = kw.pop("headers", {})
    for a in range(5):
        if not TOKEN and PAK and time.time() > _pak_expires - 120:
            pak_token()
        r = requests.request(method, BASE + path, headers={**H, **extra}, timeout=120, **kw)
        if r.status_code == 401 and not TOKEN and PAK:
            pak_token()
            continue
        if r.status_code == 403 and "scope" in r.text.lower():
            sys.exit(f"Missing scope for {method} {path}: {r.text[:300]}")
        if r.status_code == 429 or r.status_code >= 500:
            time.sleep(int(r.headers.get("Retry-After", 2 ** a)))
            continue
        return r
    return r


def folder_id(path, create=True):
    r = call("GET", f"/files/v3/files/stat/{requests.utils.quote(path.lstrip('/'))}")
    if r.status_code == 200 and r.json().get("folder"):
        return r.json()["folder"]["id"]
    if not create:
        return None
    parent, name = path.rsplit("/", 1)
    body = {"name": name}
    if parent:
        body["parentPath"] = parent
    r = call("POST", "/files/v3/folders", json=body)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Couldn't create folder {path}: {r.status_code} {r.text[:200]}")
    return r.json()["id"]


def incoming_files(fid):
    out, after = [], None
    while True:
        params = {"parentFolderIds": fid, "limit": 100}
        if after:
            params["after"] = after
        r = call("GET", "/files/v3/files/search", params=params)
        if r.status_code != 200:
            raise RuntimeError(f"File search failed: {r.status_code} {r.text[:200]}")
        d = r.json()
        out += [f for f in d.get("results", []) if re.search(FILE_TYPES, f.get("name", "") + "." + f.get("extension", ""), re.I)]
        after = d.get("paging", {}).get("next", {}).get("after")
        if not after:
            return out


def download(f):
    r = call("GET", f"/files/v3/files/{f['id']}/signed-url")
    url = r.json().get("url") if r.status_code == 200 else f.get("url")
    d = requests.get(url, timeout=300)
    d.raise_for_status()
    return d.content


def upload_book(book, live_folder_id):
    name = book_file_name(book)
    files = {"file": (name, json.dumps(book, separators=(",", ":")).encode(), "application/json")}
    data = {"folderId": live_folder_id, "options": json.dumps({"access": "PRIVATE", "overwrite": False})}
    r = call("POST", "/files/v3/files", files=files, data=data)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"Upload of {name} failed: {r.status_code} {r.text[:200]}")
    return r.json()


def move(f, target_folder_id):
    call("PATCH", f"/files/v3/files/{f['id']}", json={"parentFolderId": target_folder_id})


def index_rows():
    rows, after = [], None
    while True:
        r = call("GET", f"/cms/v3/hubdb/tables/{TABLE}/rows/draft", params={"limit": 1000, **({"after": after} if after else {})})
        if r.status_code != 200:
            raise RuntimeError(f"HubDB read failed: {r.status_code} {r.text[:200]}")
        d = r.json()
        rows += d.get("results", [])
        after = d.get("paging", {}).get("next", {}).get("after")
        if not after:
            return rows


def write_index(new_books, uploaded, source_label, checks_text):
    now = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    existing = index_rows()
    supersede = []
    for b in new_books:
        m = b["meta"]
        for row in existing:
            v = row.get("values", {})
            if (v.get("status") == "live" and v.get("supplier") == m["supplier"] and v.get("fuel") == m["fuel"]
                    and str(v.get("region")) == m["region"] and (v.get("contract_type") or "ANY") == m["contract_type"]
                    and file_variant(v.get("source_file")) == file_variant(source_label)):
                supersede.append(row["id"])
    if supersede:
        r = call("POST", f"/cms/v3/hubdb/tables/{TABLE}/rows/draft/batch/update",
                 json={"inputs": [{"id": i, "values": {"status": "superseded"}} for i in set(supersede)]})
        if r.status_code not in (200, 207):
            raise RuntimeError(f"HubDB update failed: {r.status_code} {r.text[:200]}")
    inputs = []
    for b, f in zip(new_books, uploaded):
        m = b["meta"]
        inputs.append({"values": {
            "book_id": str(f["id"]), "supplier": m["supplier"], "fuel": m["fuel"], "region": m["region"],
            "contract_type": m["contract_type"], "valid_from": m["valid_from"] or "", "quote_by": m["quote_by"] or "",
            "file_url": f.get("url", ""), "row_count": str(m["rows"]), "status": "live", "loaded_at": now,
            "source_file": source_label, "checks": checks_text}})
    for i in range(0, len(inputs), 100):
        r = call("POST", f"/cms/v3/hubdb/tables/{TABLE}/rows/draft/batch/create", json={"inputs": inputs[i:i + 100]})
        if r.status_code not in (200, 201, 207):
            raise RuntimeError(f"HubDB insert failed: {r.status_code} {r.text[:200]}")
    r = call("POST", f"/cms/v3/hubdb/tables/{TABLE}/draft/publish")
    if r.status_code not in (200, 201):
        raise RuntimeError(f"HubDB publish failed: {r.status_code} {r.text[:200]}")
    return len(set(supersede))


# ---------------------------------------------------------------- supplier native formats
def file_date(name):
    """Date in a native file name: 20261124_... (yyyymmdd) or rate_card_261126_... (ddmmyy)."""
    n = os.path.basename(name)
    m = re.search(r"(?:^|_)(20\d{6})_", n)
    if m:
        return dt.datetime.strptime(m.group(1), "%Y%m%d").date()
    m = re.search(r"_(\d{6})_", n)
    return dt.datetime.strptime(m.group(1), "%d%m%y").date() if m else None


def native_supplier(name):
    """Supplier code put in front of a flat file name: YU_20261124_POW_ACQ_R.csv -> Yu Energy."""
    m = re.match(r"^([A-Za-z]+)_\d{8}_", os.path.basename(name))
    if not m or m.group(1).upper() not in SUPPLIER_CODES:
        raise ValueError(f"'{name}' doesn't say which supplier it is from. Rename it with the supplier code in front, "
                         f"e.g. YU_{os.path.basename(name)} (codes: {', '.join(sorted(SUPPLIER_CODES))})")
    return SUPPLIER_CODES[m.group(1).upper()]


def clean(v):
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    if hasattr(v, "item"):  # numpy scalar -> plain python
        v = v.item()
    return v


def native_loads(name, data, today):
    """Native file -> list of loads, one per fuel and contract type in the file."""
    kind = native_readers.detect(name)
    supplier = native_supplier(name) if kind in ("flatfile_pow", "flatfile_gas") else None
    with tempfile.TemporaryDirectory() as d:  # pyxlsb needs a file on disk
        path = os.path.join(d, os.path.basename(name))
        with open(path, "wb") as fh:
            fh.write(data)
        df = native_readers.read(path, supplier=supplier, today=dt.date.fromisoformat(today))
    problems = native_readers.problems(df)
    fdate = file_date(name)
    version = fdate.isoformat() if fdate else None
    quote_by = ((fdate or dt.date.fromisoformat(today)) + dt.timedelta(days=NATIVE_QUOTE_DAYS)).isoformat()
    loads = []
    for (sup, fuel, ctype), g in df.groupby(["supplier", "fuel", "contract_type"], dropna=False):
        rows = []
        for r in g.to_dict("records"):
            out = {c: clean(r.get(c)) for c in COLS}
            out["green"] = bool(r["green"]) if clean(r.get("green")) is not None else None
            out["term"] = int(out["term"]) if out["term"] is not None else None
            out["region"] = str(clean(r["region"]))
            rows.append(out)
        errors, notes = check(rows, quote_by, today)
        errors = problems + errors
        unpriced = sum(1 for r in rows if r["rate_type"] in ("night_only", "ew_winter", "daynight_winter"))
        if unpriced:
            notes.append(f"{unpriced} rows on meter types the card can't price yet (night only / winter evening)")
        loads.append((sup, ctype, fuel, rows, quote_by, version, version, errors, notes))
    return loads


def file_variant(source):
    """ECO (green) files sit alongside the standard file for the same supplier, fuel and region."""
    return "ECO" if re.search(r"_ECO(\.|_| |$)", str(source), re.I) else ""


# ---------------------------------------------------------------- main
def process(name, data, today):
    """Returns a list of loads: (supplier, ctype, fuel, rows, quote_by, valid_from, version, errors, notes)."""
    if native_readers.detect(name):
        return native_loads(name, data, today)
    supplier, ctype = parse_name(name)
    fuel, rows, quote_by, valid_from, version = transform(read_frame(name, data))
    errors, notes = check(rows, quote_by, today)
    return [(supplier, ctype, fuel, rows, quote_by, valid_from, version, errors, notes)]


def run_local(paths):
    today = dt.date.today().isoformat()
    os.makedirs("out", exist_ok=True)
    for p in paths:
        with open(p, "rb") as fh:
            loads = process(p, fh.read(), today)
        if any(l[7] for l in loads):
            for l in loads:
                if l[7]:
                    print(f"{os.path.basename(p)}: {l[0]} {l[2]} {l[1]} ERRORS: {'; '.join(l[7])}")
            continue
        for supplier, ctype, fuel, rows, quote_by, valid_from, version, errors, notes in loads:
            print(f"{os.path.basename(p)}: {supplier} {fuel} {ctype}, quote by {quote_by}, {'; '.join(notes)}")
            for b in books_from(supplier, ctype, fuel, rows, quote_by, valid_from, version, os.path.basename(p)):
                path = os.path.join("out", book_file_name(b))
                with open(path, "w") as fh:
                    json.dump(b, fh, separators=(",", ":"))
                print(f"  {path}: {b['meta']['rows']} rows, {os.path.getsize(path) // 1024} KB")


def run_hubspot():
    if not TOKEN and not PAK:
        sys.exit("Set HUBSPOT_PERSONAL_ACCESS_KEY (or HUBSPOT_PRICEBOOK_TOKEN)")
    print("=" * 70)
    print("DRY RUN - nothing will be written" if DRY_RUN else "LIVE RUN - price books WILL be published")
    print("=" * 70)
    today = dt.date.today().isoformat()
    ids = {k: folder_id(v, create=not DRY_RUN) for k, v in FOLDERS.items()}
    if not ids["incoming"]:
        print(f"No folder {FOLDERS['incoming']} yet - nothing to load")
        return
    files = incoming_files(ids["incoming"])
    print(f"{len(files)} file(s) waiting in {FOLDERS['incoming']}")
    for f in files:
        name = f"{f['name']}.{f['extension']}" if f.get("extension") and not f["name"].lower().endswith(f".{f['extension'].lower()}") else f["name"]
        label = f"{name} ({f['id']})"
        try:
            loads = process(name, download(f), today)
        except Exception as e:  # unreadable file: report it, move it aside, carry on
            print(f"  {label}: FAILED - {e}")
            if not DRY_RUN:
                move(f, ids["failed"])
            continue
        failed = [l for l in loads if l[7]]
        if failed:  # all or nothing per file, so a file never half-loads
            for l in failed:
                print(f"  {label}: FAILED checks ({l[0]} {l[2]} {l[1]}) - {'; '.join(l[7])}")
            if not DRY_RUN:
                move(f, ids["failed"])
            continue
        for supplier, ctype, fuel, rows, quote_by, valid_from, version, errors, notes in loads:
            books = books_from(supplier, ctype, fuel, rows, quote_by, valid_from, version, name)
            print(f"  {label}: {supplier} {fuel} {ctype}, quote by {quote_by}, {len(books)} region book(s), {'; '.join(notes)}")
            if DRY_RUN:
                continue
            uploaded = [upload_book(b, ids["live"]) for b in books]
            replaced = write_index(books, uploaded, label, "; ".join(notes))
            print(f"    published {len(uploaded)} book(s), superseded {replaced}")
        if not DRY_RUN:
            move(f, ids["processed"])
    if DRY_RUN:
        print("\nDRY RUN complete. Run with DRY_RUN=false to publish.")


if __name__ == "__main__":
    if len(sys.argv) > 2 and sys.argv[1] == "--local":
        run_local(sys.argv[2:])
    else:
        run_hubspot()
