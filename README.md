# Troo Sales Tools (HubSpot app)

Private HubSpot app for Troo's sales teams.

- **Supplier revenue calculator**: ranks every supplier product by the commission it earns on a deal. Shown as a card on Deal records (prefilled from the deal's meters and CED, with "Save to deal") and as an app page for quick checks.
- **Fixed price comparison**: next.

## How it fits together

| Part | Where |
|---|---|
| Supplier stipulations | HubDB tables `stip_products`, `stip_comms_bands`, `stip_rules` (portal 26661912). Source CSVs and schema in `hubdb/` |
| Calculation | App function `stip_calculate` (`src/app/functions/lib/engine.js`), so there's one engine and commission logic stays server-side |
| Deal prefill | App function `stip_deal_context`: AQ and utility from associated Meters, start date from `ced_group_date`, current supplier from the Meter's current contract supplier |
| Save to deal | App function `stip_save_estimate` writes the `est_comms_*` Deal properties. Never writes `amount` |
| UI | `shared/RevenueCalculator.tsx`, copied into the card and the page by `npm run sync` |

## Monthly stipulation update

1. Edit the rows in HubDB (Content > HubDB) and publish. No code release needed.
2. For a full refresh, update the CSVs in `hubdb/`, run `hubdb/load_hubdb_stips.py` in Colab (dry run first), and update `test/fixtures/` so the tests track the new month.

## Developing

```sh
npm run sync     # after editing shared/RevenueCalculator.tsx
npm test         # engine + function tests (no HubSpot needed)
```

Pushing to `main` runs the tests, then validates and uploads the project to HubSpot through GitHub Actions. It needs, in the `hubspot-production` environment: secret `HUBSPOT_PERSONAL_ACCESS_KEY` and variable `HUBSPOT_ACCOUNT_ID` (26661912).

Never commit `hubspot.config.yml`: it holds a personal access key.
