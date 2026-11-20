# load_hubdb_stips.py
# Creates (first run) or refreshes (monthly) the three supplier stipulation HubDB tables
# from hubdb_stip_schema.json and the three CSVs, then publishes them.
#
# Run in Colab: upload the 4 files, add PRIVATE_APP_ACCESS_TOKEN to Colab Secrets
# (the private app needs the hubdb scope), run with DRY_RUN = True, check the output,
# then set DRY_RUN = False.
#
# Canary first: set TABLE_PREFIX = "test_" for the first live run, check the tables in
# HubSpot (Content > HubDB), then delete them and run again with TABLE_PREFIX = "".

import csv, json, time, datetime as dt, requests

DRY_RUN = True          # <<< set to False only after checking a dry run
TABLE_PREFIX = ""        # e.g. "test_" for the canary run
PUBLISH = True           # push draft rows live after loading
SCHEMA_FILE = "hubdb_stip_schema.json"
CSV_FILES = {"stip_products": "stip_products.csv",
             "stip_comms_bands": "stip_comms_bands.csv",
             "stip_rules": "stip_rules.csv"}

try:
    from google.colab import userdata
    TOKEN = userdata.get("PRIVATE_APP_ACCESS_TOKEN")
except Exception:
    TOKEN = ""           # leave blank; never hardcode the token here

BASE = "https://api.hubapi.com/cms/v3/hubdb/tables"
H = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

if DRY_RUN:
    print("=" * 70 + "\nDRY RUN: nothing will be written to HubSpot\n" + "=" * 70)
else:
    print("!" * 70 + "\nLIVE RUN: tables will be created/replaced and published\n" + "!" * 70)


def call(method, url, body=None, tries=5):
    """HTTP call with 5xx / 429 retry and Retry-After support. Returns (status, json)."""
    for i in range(tries):
        r = requests.request(method, url, headers=H, json=body, timeout=60)
        if r.status_code in (429,) or r.status_code >= 500:
            wait = float(r.headers.get("Retry-After", 2 ** i))
            print(f"  {r.status_code} on {method} {url}, retrying in {wait}s")
            time.sleep(wait); continue
        try:
            data = r.json() if r.text else {}
        except ValueError:
            data = {"raw": r.text}
        return r.status_code, data
    return r.status_code, {"error": "gave up after retries"}


def epoch_ms(iso):
    d = dt.date.fromisoformat(iso)
    return int(dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc).timestamp() * 1000)


def convert(value, col):
    """CSV text -> HubDB value for the column type. Blank -> None (column left empty)."""
    if value is None or value == "":
        return None
    t = col["type"]
    if t == "NUMBER":
        return float(value)
    if t == "BOOLEAN":
        return value.strip().lower() == "true"
    if t == "DATE":
        return epoch_ms(value)
    if t == "SELECT":
        allowed = {o["name"] for o in col.get("options", [])}
        if value not in allowed:
            raise ValueError(f"'{value}' is not an option of {col['name']} ({sorted(allowed)})")
        return {"name": value, "type": "option"}
    return value


schema = json.load(open(SCHEMA_FILE))
print(f"Stipulation month: {schema['stip_month']}")

for t in schema["tables"]:
    name = TABLE_PREFIX + t["name"]
    cols = {c["name"]: c for c in t["columns"]}
    rows = list(csv.DictReader(open(CSV_FILES[t["name"]], encoding="utf-8")))

    # pre-flight: CSV headers must match the schema exactly
    missing, extra = set(cols) - set(rows[0]), set(rows[0]) - set(cols)
    if missing or extra:
        raise SystemExit(f"{name}: CSV/schema mismatch. Missing {missing}, extra {extra}")
    inputs = [{"values": {k: v for k, v in ((k, convert(r[k], cols[k])) for k in cols) if v is not None}} for r in rows]
    print(f"\n{name}: {len(inputs)} rows prepared")

    status, existing = call("GET", f"{BASE}/{name}/draft")
    if status == 404:
        print(f"  table does not exist: will create it with {len(cols)} columns")
        if not DRY_RUN:
            body = {k: t[k] for k in ("name", "label", "useForPages", "allowPublicApiAccess")}
            body["name"] = name
            body["columns"] = [{k: c[k] for k in ("name", "label", "type") } | ({"options": c["options"]} if c.get("options") else {}) for c in t["columns"]]
            s, d = call("POST", BASE, body)
            if s not in (200, 201):
                raise SystemExit(f"  create failed {s}: {d}")
            print(f"  created table id {d.get('id')}")
    elif status == 200:
        # pre-flight: every schema column must already exist on the live table
        have = {c["name"] for c in existing.get("columns", [])}
        gap = set(cols) - have
        if gap:
            raise SystemExit(f"  existing table is missing columns {gap}: add them in HubSpot or via the API first")
        # manifest of current draft rows before they are replaced (undo log)
        old, after = [], None
        while True:
            s, d = call("GET", f"{BASE}/{name}/rows/draft?limit=1000" + (f"&after={after}" if after else ""))
            if s not in (200, 207):
                raise SystemExit(f"  reading rows failed {s}: {d}")
            old += d.get("results", [])
            after = (d.get("paging") or {}).get("next", {}).get("after")
            if not after:
                break
        stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
        mf = f"manifest_{name}_{stamp}.json"
        json.dump(old, open(mf, "w"), indent=1)
        print(f"  table exists with {len(old)} draft rows; saved them to {mf}; they will be replaced")
        if not DRY_RUN and old:
            ids = [r["id"] for r in old]
            for i in range(0, len(ids), 100):
                s, d = call("POST", f"{BASE}/{name}/rows/draft/batch/purge", {"inputs": ids[i:i + 100]})
                if s not in (200, 204, 207):
                    raise SystemExit(f"  purge failed {s}: {d}")
    else:
        raise SystemExit(f"  unexpected {status} reading table: {existing}")

    if DRY_RUN:
        print(f"  would insert {len(inputs)} rows; first row: {json.dumps(inputs[0])[:300]}...")
        continue

    for i in range(0, len(inputs), 100):
        s, d = call("POST", f"{BASE}/{name}/rows/draft/batch/create", {"inputs": inputs[i:i + 100]})
        if s not in (200, 201, 207):
            raise SystemExit(f"  insert failed at row {i} ({s}): {d}")
        errs = d.get("errors") or []
        print(f"  inserted rows {i + 1}-{min(i + 100, len(inputs))}" + (f", {len(errs)} errors: {errs[:2]}" if errs else ""))

    if PUBLISH:
        s, d = call("POST", f"{BASE}/{name}/draft/push-live")
        print(f"  published ({s})" if s in (200, 201) else f"  publish failed {s}: {d}")

print("\nDone." + (" Dry run only: set DRY_RUN = False to load." if DRY_RUN else ""))
