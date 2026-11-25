# Troo Sales Tools (HubSpot app)

Private HubSpot app for Troo's sales teams.

- **Supplier revenue calculator**: ranks every supplier product by the commission it earns on a deal. Shown as a card on Deal records (prefilled from the deal's meters and CED, with "Save to deal") and as an app page for quick checks.
- **Matrix prices**: prices every meter on a deal from the suppliers' matrix price books, adds commission (capped by the stipulations), ranks the options, lists which suppliers aren't quoting and why, and saves the chosen option to the deal. Shown as a card on Deal records.
- **Fixed price comparison**: next.

## How it fits together

| Part | Where |
|---|---|
| Supplier stipulations | HubDB tables `stip_products`, `stip_comms_bands`, `stip_rules` (portal 26661912). Source CSVs and schema in `hubdb/` |
| Calculation | App function `stip_calculate` (source `functions-src/lib/engine.js`), so there's one engine and commission logic stays server-side |
| Deal prefill | App function `stip_deal_context`: AQ and utility from associated Meters, start date from `ced_group_date`, current supplier from the Meter's current contract supplier |
| Save to deal | App function `stip_save_estimate` writes the `est_comms_*` Deal properties. Never writes `amount` |
| UI | `shared/RevenueCalculator.tsx`, copied into the card and the page by `npm run sync` |

## Matrix prices

| Part | Where |
|---|---|
| Price books | HubSpot file manager, `Price books/Live`: one private JSON file per supplier, fuel, contract type (ACQ/REN) and region |
| Index of live books | HubDB table `price_books` (Matrix price books): status `live` / `superseded`, quote-by date, source file, checks |
| Loader | GitHub Action *Load matrix price books* runs `hubdb/load_price_books.py` every 15 minutes (weekdays 06:00-20:00 UTC) and on demand. Uses the deploy personal access key (`HUBSPOT_PERSONAL_ACCESS_KEY` environment), which needs the Files and HubDB scopes. A private app token in `HUBSPOT_PRICEBOOK_TOKEN` is used instead if set |
| Engine | `functions-src/lib/matrix.js`, pure and tested against two real Utility Click quotes in `test/matrix.test.js`. Commission caps and eligibility come from the stipulation tables through `lib/engine.js` |
| Functions | `matrix_deal_context` (the deal's meters and the live books), `matrix_price` (prices the chosen meters). Save to deal reuses `stip_save_estimate` |
| Meter fields | `mp_band`, `mp_day_share_pct` (blank = 75), `mp_hh_voltage`, `mp_metering`, `mp_gas_ldz`, `mp_gas_exit_zone`, plus `kva`, `meter_type`, the MPAN lines and AQ |
| UI | `shared/MatrixPricing.tsx`, copied into the card by `npm run sync` |

### Loading a supplier's price book

1. Drop the file (standard UD template, named like `UD_Soar_YU_ELE_ACQ_241126.xlsx`) into `Price books/Incoming` in the file manager.
2. Within 15 minutes it moves to `Processed` and its books show as live. A file that fails the checks moves to `Failed`; the reason is in the Action's log.
3. A new supplier code needs one line in `SUPPLIER_CODES` in the loader.

To check a file without HubSpot: `python hubdb/load_price_books.py --local FILE.xlsx`

## Monthly stipulation update

1. Edit the rows in HubDB (Content > HubDB) and publish. No code release needed.
2. For a full refresh, update the CSVs in `hubdb/`, run `hubdb/load_hubdb_stips.py` in Colab (dry run first), and update `test/fixtures/` so the tests track the new month.

## Developing

Edit functions in `functions-src/`, never in `src/app/functions/`: HubSpot packages each function as one file, so `npm run build` bundles each one (with its `lib/` code inlined) into `src/app/functions/`. Commit the bundles.

```sh
npm ci           # once
npm run build    # after editing functions-src/ or shared/*.tsx
npm test         # engine + function tests against the bundles (no HubSpot needed)
```

Pushing to `main` runs the tests, then validates and uploads the project to HubSpot through GitHub Actions. It needs, in the `hubspot-production` environment: secret `HUBSPOT_PERSONAL_ACCESS_KEY` and variable `HUBSPOT_ACCOUNT_ID` (26661912). The environment is named `HUBSPOT_PERSONAL_ACCESS_KEY`.

Never commit `hubspot.config.yml`: it holds a personal access key.
