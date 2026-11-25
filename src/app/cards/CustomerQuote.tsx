// Customer quote: the options shortlisted in Matrix prices, grouped by meter.
// Preview the quote PDF, then save it to the deal; it's the file attached to the
// "Your energy prices from Troo" email and the quote the Customer accepted playbook points to.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Divider, EmptyState, Flex, Heading, LoadingSpinner, Statistics, StatisticsItem,
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow, Tag, Text, hubspot,
} from '@hubspot/ui-extensions';

type Option = {
  supplier: string; products: string[]; term: number; endDate: string | null; green: boolean;
  rates: { unit: number | null; day: number | null; night: number | null; ew: number | null };
  sc: number; kvaCharge: number | null; annual: number; commission: number; totalComms: number; quoteBy: string | null;
};
type Meter = { id: string; meterNumber: string; fuel: 'E' | 'G' | 'HH'; region: string | null; aq: number; start: string | null; site: string; company: string };
type Item = { key: string; addedAt: string; by: string; meter: Meter; option: Option };
type QuoteResult = { saved?: boolean; preview?: boolean; name?: string; url?: string | null; options?: number; meters?: number; left?: number; error?: string };

const FUEL = { E: 'Electricity', HH: 'Half-hourly', G: 'Gas' } as const;
const gbp = (v: number) => v.toLocaleString('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
const p = (v: number | null) => (v == null ? null : `${v.toFixed(3)}p`);
const uk = (iso: string | null) => (iso ? iso.slice(0, 10).split('-').reverse().join('/') : '');
const unwrap = <T,>(r: unknown): T => ((r as { body?: T })?.body ?? r) as T;
const ratesText = (o: Option) => {
  const r = o.rates;
  if (r.unit != null) return p(r.unit);
  return [r.day != null && `Day ${p(r.day)}`, r.night != null && `Night ${p(r.night)}`, r.ew != null && `Eve/wkend ${p(r.ew)}`].filter(Boolean).join(' · ');
};

export const CustomerQuote = ({ dealId, userName }: { dealId: string; userName?: string }) => {
  const [items, setItems] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<QuoteResult | null>(null);

  const call = useCallback(async (parameters: Record<string, unknown>) => {
    const out = unwrap<{ items?: Item[]; error?: string }>(await hubspot.serverless('matrix_shortlist', { parameters: { dealId, ...parameters } }));
    if (out.error) throw new Error(out.error);
    setItems(out.items || []);
  }, [dealId]);

  const load = useCallback(async () => {
    setErr(null);
    try { await call({ action: 'get' }); } catch (e) { setErr(`Couldn't read the shortlist: ${(e as Error).message}`); }
  }, [call]);

  useEffect(() => { load(); }, [load]);

  const remove = async (key: string) => {
    setBusy(key); setErr(null); setResult(null);
    try { await call({ action: 'remove', key }); } catch (e) { setErr(`Couldn't remove it: ${(e as Error).message}`); }
    setBusy(null);
  };
  const clear = async () => {
    setBusy('clear'); setErr(null); setResult(null);
    try { await call({ action: 'clear' }); } catch (e) { setErr(`Couldn't clear the shortlist: ${(e as Error).message}`); }
    setBusy(null);
  };
  const quote = async (action: 'preview' | 'save') => {
    setBusy(action); setErr(null); setResult(null);
    try {
      const out = unwrap<QuoteResult>(await hubspot.serverless('matrix_quote', { parameters: { dealId, action, by: userName } }));
      if (out.error) setErr(out.error); else setResult(out);
      if (action === 'save' && !out.error) await call({ action: 'get' });
    } catch (e) { setErr(`Couldn't ${action === 'save' ? 'save' : 'preview'} the quote: ${(e as Error).message}`); }
    setBusy(null);
  };

  const groups = useMemo(() => {
    const map = new Map<string, { meter: Meter; items: Item[] }>();
    for (const it of items || []) {
      if (!map.has(it.meter.id)) map.set(it.meter.id, { meter: it.meter, items: [] });
      map.get(it.meter.id)!.items.push(it);
    }
    const out = [...map.values()];
    out.forEach((g) => g.items.sort((a, b) => a.option.annual - b.option.annual || a.option.term - b.option.term));
    return out;
  }, [items]);
  const validUntil = useMemo(() => (items || []).map((i) => i.option.quoteBy).filter(Boolean).sort()[0] || null, [items]);
  const company = (items || []).find((i) => i.meter.company)?.meter.company || '';

  if (items === null && !err) return <LoadingSpinner label="Reading the shortlist" />;

  return (
    <Flex direction="column" gap="md">
      <Flex direction="row" justify="between" align="center">
        <Heading>Customer quote{company ? ` · ${company}` : ''}</Heading>
        <Button size="sm" onClick={load} disabled={!!busy}>Refresh</Button>
      </Flex>
      {err && <Alert title="Something went wrong" variant="error">{err}</Alert>}
      {result?.saved && (
        <Alert title="Quote saved to the deal" variant="success">
          {result.name} is attached to the deal ({result.options} option{result.options === 1 ? '' : 's'}, {result.meters} meter{result.meters === 1 ? '' : 's'}). Send it with the "Your energy prices from Troo" email from the deal, attaching this PDF. When the customer accepts, choose it in question 9 of the Customer accepted playbook.
          {result.url && <Button size="xs" href={{ url: result.url, external: true }}>Open the quote</Button>}
        </Alert>
      )}
      {result?.preview && (
        <Alert title="Preview ready" variant="info">
          This is exactly what the customer will see. Nothing has been saved to the deal yet.
          {result.url && <Button size="xs" href={{ url: result.url, external: true }}>Open the preview</Button>}
        </Alert>
      )}

      {items && !items.length ? (
        <EmptyState title="Start your shortlist" layout="vertical" imageName="addOnReporting">
          <Text>Price a meter on the Matrix prices tab and tick the options you want to offer. They collect here, ready to save as the customer's quote.</Text>
        </EmptyState>
      ) : (
        <>
          <Statistics>
            <StatisticsItem label="Options shortlisted" number={String(items?.length || 0)} />
            <StatisticsItem label="Meters covered" number={String(groups.length)} />
            <StatisticsItem label="Prices valid until" number={validUntil ? uk(validUntil) : '-'} />
          </Statistics>

          {groups.map((g) => {
            const m = g.meter;
            return (
              <Flex key={m.id} direction="column" gap="xs">
                <Text format={{ fontWeight: 'bold' }}>{m.meterNumber || 'Meter'} · {FUEL[m.fuel]} · {Math.round(m.aq).toLocaleString('en-GB')} kWh · from {uk(m.start)}</Text>
                {m.site && <Text variant="microcopy">{m.site}</Text>}
                <Table bordered>
                  <TableHead>
                    <TableRow>
                      <TableHeader>Supplier and product</TableHeader>
                      <TableHeader>Length</TableHeader>
                      <TableHeader>Rates</TableHeader>
                      <TableHeader>Standing charge</TableHeader>
                      <TableHeader>Yearly cost</TableHeader>
                      <TableHeader>Commission</TableHeader>
                      <TableHeader width="min"> </TableHeader>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {g.items.map((it, i) => {
                      const o = it.option;
                      return (
                        <TableRow key={it.key}>
                          <TableCell>
                            <Text format={{ fontWeight: i === 0 ? 'demibold' : 'regular' }}>{o.supplier}</Text>
                            <Text variant="microcopy">{o.products.join(' / ')}</Text>
                            <Flex direction="row" gap="xs" wrap="wrap">
                              {i === 0 && g.items.length > 1 && <Tag variant="success">Best price</Tag>}
                              {o.green && <Tag variant="info">Green</Tag>}
                              {o.endDate && <Tag variant="warning">Fixed end date</Tag>}
                            </Flex>
                          </TableCell>
                          <TableCell>{o.endDate ? `To ${uk(o.endDate)}` : `${o.term} months`}</TableCell>
                          <TableCell>{ratesText(o)}</TableCell>
                          <TableCell>{o.sc ? `${o.sc.toFixed(2)}p/day` : 'None'}{o.kvaCharge ? ` + ${o.kvaCharge}p/kVA/m` : ''}</TableCell>
                          <TableCell><Text format={{ fontWeight: 'demibold' }}>{gbp(o.annual)}</Text></TableCell>
                          <TableCell>{gbp(o.totalComms)}<Text variant="microcopy">{o.commission}p/kWh</Text></TableCell>
                          <TableCell width="min">
                            <Button size="xs" variant="transparent" onClick={() => remove(it.key)} disabled={!!busy}>{busy === it.key ? 'Removing…' : 'Remove'}</Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </Flex>
            );
          })}

          <Text variant="microcopy">Commission shows here for you only. The customer's PDF shows the prices, with a line saying Troo is paid a commission by the supplier. Prices exclude CCL and VAT.</Text>
          <Divider />
          <Flex direction="row" gap="sm" justify="end">
            <Button onClick={clear} disabled={!!busy}>{busy === 'clear' ? 'Clearing…' : 'Clear shortlist'}</Button>
            <Button onClick={() => quote('preview')} disabled={!!busy}>{busy === 'preview' ? 'Building preview…' : 'Preview quote'}</Button>
            <Button variant="primary" onClick={() => quote('save')} disabled={!!busy}>{busy === 'save' ? 'Saving…' : 'Save quote to deal'}</Button>
          </Flex>
        </>
      )}
    </Flex>
  );
};
