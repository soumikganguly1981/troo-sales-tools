// Meter Capture (deal tab, run at LOA Signed): bills and/or the Excel meter list in, Sites, Meters
// and deals out. Steps: Upload > Read > Look up > Review & confirm > Add to HubSpot.
// The rules (meter numbers, grouping into deals, Site matching) live in the app functions, so the
// preview here is exactly what Add to HubSpot writes.
import React, { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Checkbox, DateInput, Divider, EmptyState, FileUpload, Flex, Heading, Input, Link, LoadingSpinner, NumberInput,
  ProgressBar, Select, StatisticsItem, Statistics, StepIndicator, Table, TableBody, TableCell, TableHead, TableHeader,
  TableRow, Tag, Text, hubspot,
} from '@hubspot/ui-extensions';
import type { CrmContext } from '@hubspot/ui-extensions';

type Fuel = 'Elec' | 'Gas';
type Rates = { day?: number | null; night?: number | null; unit?: number | null; standing_charge?: number | null; rates_from?: string | null };
type Meter = {
  number: string; fuel: Fuel | null; valid: boolean; problem?: string | null; profile?: string; topLine?: string;
  ced: string | null; cedDayMissing?: boolean; cedText?: string | null; address?: string | null; postcode?: string | null;
  annualKwh?: number | null; rates?: Rates | null; source: string; billSupplier?: string | null; billSupplierMatch?: string | null;
  toCheck?: string[]; included?: boolean; supplier?: string | null; overrideReason?: string;
  registrySupplier?: string | null; registryCode?: string | null; registrySince?: string | null; registryNote?: string;
  registryCheck?: string | null; registryAddress?: string | null; registryPostcode?: string | null; mismatchChecked?: boolean; uprn?: string | null; meterSerial?: string | null;
  existingId?: string | null; existingSupplier?: string | null; files?: string[];
  profileClass?: string | null; meterType?: string | null; ldz?: string | null; kva?: number | null; voltage?: string | null;
};
type UploadedFile = { id: number; name: string; extension: string; size: number };
type Ctx = {
  deal: { id: string; name: string; status: string; splitFrom: string | null; completedOn: string | null };
  company: { id: string; name: string } | null; sites: unknown[]; meterCount: number; suppliers: string[];
  features: { billReading: boolean; electralink: boolean; xoserve: boolean };
  draft: { meters?: Meter[]; files?: UploadedFile[]; savedAt?: string } | null; notes: string[]; error?: string;
};
type Group = { key: string; kind: 'this' | 'gas' | 'future'; label: string; meters: string[]; earliestCed: string | null; flags: string[];
  dealName: string; exists: boolean; stage: string | null; dealId?: string; created?: boolean; stageNote?: string; missing?: string[]; dataComplete?: boolean };
type Preview = { groups: Group[]; sites: { new: number; matched: number; newList: { address: string; postcode: string }[] };
  meters: { new: number; existing: number; unticked: number }; warnings: string[]; error?: string };
type Result = { deals: Group[]; sites: { created: number; matched: number }; meters: { created: number; updated: number; unticked: number }; warnings: string[]; error?: string };
type DateVal = { year: number; month: number; date: number };

const STEPS = ['Upload', 'Read', 'Look up', 'Review & confirm', 'Add to HubSpot'];
const BILL_EXT = ['pdf', 'jpg', 'jpeg', 'png', 'webp'];
const SHEET_EXT = ['xlsx', 'xls', 'csv'];
const unwrap = <T,>(r: unknown): T => ((r as { body?: T })?.body ?? r) as T;
const toDate = (iso: string | null | undefined): DateVal | undefined => { if (!iso) return undefined; const [y, m, d] = iso.split('-').map(Number); return { year: y, month: m - 1, date: d }; };
const fromDate = (v: DateVal | null) => (v ? `${v.year}-${String(v.month + 1).padStart(2, '0')}-${String(v.date).padStart(2, '0')}` : null);
const uk = (iso: string | null | undefined) => (iso ? iso.split('-').reverse().join('/') : '');
const label = (m: Meter) => (m.fuel === 'Gas' ? 'MPRN' : 'MPAN');
const kwh = (n: number | null | undefined) => (n ? `${Math.round(n).toLocaleString('en-GB')} kWh` : '');
const reasonNeeded = (m: Meter) => !!m.registrySupplier && !!m.supplier && m.supplier !== m.registrySupplier;
// Same rule as missingForPricing in functions-src/lib/meters.js (the server's check is the one saved)
const LDZ = ['EA', 'EM', 'NE', 'NO', 'NT', 'NW', 'SC', 'SE', 'SO', 'SW', 'WM', 'WN', 'WS'].map((v) => ({ value: v, label: v }));
const PROFILE_OPTS = ['00', '01', '02', '03', '04', '05', '06', '07', '08'].map((v) => ({ value: v, label: v === '00' ? '00 (half hourly)' : `Profile class ${v}` }));
const METER_TYPES = ['Standard', 'Economy 7', 'Off Peak', 'Evening/Weekend', 'Evening/Weekend/Night'].map((v) => ({ value: v, label: v }));
const VOLTAGES = ['Low voltage', 'LV substation', 'LV network non-CT', 'High voltage'].map((v) => ({ value: v, label: v }));
const profileOf = (m: Meter) => m.profile || m.profileClass || null;
const typeOf = (m: Meter) => m.meterType || (m.rates?.day != null && m.rates?.night != null ? 'Economy 7' : m.rates?.unit != null ? 'Standard' : null);
function pricingGaps(m: Meter): string[] {
  if (m.included === false) return [];
  const out: string[] = [];
  if (!m.ced) out.push('contract end date');
  if (!(Number(m.annualKwh) > 0)) out.push('annual consumption');
  if (m.fuel === 'Gas') { if (!m.ldz) out.push('gas zone (LDZ)'); }
  else {
    if (!profileOf(m)) out.push('profile class');
    if (profileOf(m) === '00') { if (!(Number(m.kva) > 0)) out.push('kVA'); if (!m.voltage) out.push('HH voltage'); }
    else if (!typeOf(m)) out.push('meter type');
  }
  return out;
}
const mismatch = (m: Meter) => m.registryCheck === 'mismatch';
const ready = (m: Meter) => m.included === false || (m.valid && !!m.fuel && !!m.supplier && (!reasonNeeded(m) || (m.overrideReason || '').trim().length > 3)
  && (!mismatch(m) || !!m.mismatchChecked));

// a bill and the Excel list can both carry the same meter: keep the bill's details, fill gaps from the other
function mergeMeters(list: Meter[]): Meter[] {
  const by = new Map<string, Meter>();
  for (const m of list) {
    const key = m.number || `${m.source}-${by.size}`;
    const had = by.get(key);
    if (!had) { by.set(key, { ...m, included: m.included ?? true, files: m.files || [] }); continue; }
    const keep = had.source === 'Excel' && m.source !== 'Excel' ? { ...m, ced: m.ced || had.ced } : { ...had, ced: had.ced || m.ced };
    by.set(key, { ...had, ...keep, toCheck: [...new Set([...(had.toCheck || []), ...(m.toCheck || [])])], files: [...(had.files || []), ...(m.files || [])], included: true });
  }
  return [...by.values()];
}

const memory = new Map<string, { step: number; files: UploadedFile[]; meters: Meter[]; log: string[]; problems: string[] }>();

export const MeterCapture = ({ context }: { context: CrmContext }) => {
  const dealId = String(context.crm.objectId);
  const portalId = context.portal.id;
  const userName = [context.user?.firstName, context.user?.lastName].filter(Boolean).join(' ');
  const env = String(context.variables?.ENV || '');
  const futureStage = String(context.variables?.MC_FUTURE_STAGE || 'auto');
  const saved = memory.get(dealId);

  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [step, setStep] = useState(saved?.step ?? 0);
  const [files, setFiles] = useState<UploadedFile[]>(saved?.files ?? []);
  const [meters, setMeters] = useState<Meter[]>(saved?.meters ?? []);
  const [log, setLog] = useState<string[]>(saved?.log ?? []);
  const [problems, setProblems] = useState<string[]>(saved?.problems ?? []);
  const [busy, setBusy] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [manual, setManual] = useState({ number: '', fuel: 'Elec', ced: null as string | null });

  useEffect(() => { memory.set(dealId, { step, files, meters, log, problems }); }, [dealId, step, files, meters, log, problems]);

  useEffect(() => {
    (async () => {
      try {
        const c = unwrap<Ctx>(await hubspot.serverless('mc_context', { parameters: { dealId } }));
        if (c.error) throw new Error(c.error);
        setCtx(c);
      } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    })();
  }, [dealId]);

  const update = (i: number, patch: Partial<Meter>) => setMeters((all) => all.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const saveDraft = async (ms: Meter[], fs: UploadedFile[]) => {
    try { await hubspot.serverless('mc_context', { parameters: { dealId, action: 'saveDraft', draft: { meters: ms, files: fs, savedAt: new Date().toISOString() } } }); }
    catch { /* a draft is a convenience; the capture carries on without it */ }
  };

  // 2. Read every file, one call each (bills get a second, checking call)
  const readFiles = async () => {
    setError(''); setStep(1); setLog([]); setProblems([]); setProgress(0);
    const found: Meter[] = [...meters.filter((m) => m.source === 'Manual')];
    const lines: string[] = []; const issues: string[] = [];
    const total = files.length || 1;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (!ctx?.features.billReading && BILL_EXT.includes(f.extension.toLowerCase())) {
        lines.push(`${f.name}: kept on the deal, not read (bill reading isn't switched on yet)`);
        setLog([...lines]); setProgress(Math.round(((i + 1) / total) * 100)); continue;
      }
      setBusy(`Reading ${f.name}`);
      try {
        const r = unwrap<{ error?: string; kind?: string; meters?: Meter[]; raw?: unknown; problems?: string[]; unclear?: string[]; log?: string }>(
          await hubspot.serverless('mc_read', { parameters: { dealId, fileId: f.id, mode: 'file' } }));
        if (r.error) throw new Error(r.error);
        lines.push(r.log || f.name); issues.push(...(r.problems || []));
        if ((r.unclear || []).length) issues.push(`${f.name}: hard to read: ${(r.unclear || []).join(', ')}`);
        let ms = r.meters || [];
        if (r.kind === 'bill' && ms.length) {
          setBusy(`Checking ${f.name}`);
          const c = unwrap<{ error?: string; meters?: Meter[]; log?: string }>(await hubspot.serverless('mc_read', { parameters: { dealId, fileId: f.id, mode: 'check', first: JSON.parse(JSON.stringify(r.raw ?? null)) } }));
          if (c.error) issues.push(`${f.name}: the second check didn't run (${c.error}); check the meter number and rates by eye`);
          else { ms = c.meters || ms; lines.push(c.log || ''); }
        }
        found.push(...ms.map((m) => ({ ...m, files: [f.name] })));
      } catch (e) { issues.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`); }
      setLog([...lines]); setProgress(Math.round(((i + 1) / total) * 100));
    }
    const merged = mergeMeters(found);
    const invalid = merged.filter((m) => !m.valid).length;
    lines.push(`${merged.length} meter${merged.length === 1 ? '' : 's'} found${invalid ? `, ${invalid} with a meter number to fix` : ', all meter numbers valid'}`);
    setLog([...lines]); setProblems(issues); setMeters(merged); setBusy('');
    if (merged.length) await lookUp(merged);
  };

  // 3. Registry and HubSpot lookups
  const lookUp = async (ms: Meter[]) => {
    setStep(2); setBusy('Checking each meter'); setProgress(0);
    try {
      type Found = { number: string; existing: { id: string; supplier: string | null; ced: string | null; postcode: string | null;
          profile: string | null; meterType: string | null; annualKwh: number | null; ldz: string | null; kva: number | null; voltage: string | null } | null;
        registry: { status: string; source?: string; supplierName?: string | null; registryName?: string | null; supplierCode?: string; supplierSince?: string; address?: string;
          postcode?: string; postcodeCheck?: string; annualKwh?: number; profile?: string | null; ldz?: string | null; uprn?: string | null; meterSerial?: string | null; message?: string } };
      const todo = ms.filter((m) => m.valid).map((m) => ({ number: m.number, fuel: m.fuel, postcode: m.postcode || null }));
      const found: Found[] = [];
      for (let k = 0; k < todo.length; k += 25) { // 25 per call keeps each call well under HubSpot's 15 s limit
        const r = unwrap<{ error?: string; results?: Found[] }>(await hubspot.serverless('mc_lookup', { parameters: { dealId, meters: todo.slice(k, k + 25) } }));
        if (r.error) throw new Error(r.error);
        found.push(...(r.results || []));
        setProgress(Math.round(((k + 25) / Math.max(todo.length, 1)) * 100));
      }
      const by = new Map(found.map((x) => [x.number, x]));
      const next = ms.map((m) => {
        const x = by.get(m.number);
        if (!x) return m;
        const reg = x.registry;
        const out: Meter = { ...m, existingId: x.existing?.id || null, existingSupplier: x.existing?.supplier || null };
        if (reg.status === 'ok') {
          // registry wins for supplier, address, postcode and consumption; the bill's values stay in the draft for reference
          Object.assign(out, { registrySupplier: reg.supplierName || null, registryCode: reg.supplierCode || null, registrySince: reg.supplierSince || null,
            registryCheck: reg.postcodeCheck || null, registryAddress: reg.address || null, registryPostcode: reg.postcode || null,
            address: reg.address || m.address, postcode: reg.postcode || m.postcode, annualKwh: reg.annualKwh ?? m.annualKwh ?? null,
            uprn: reg.uprn || null, meterSerial: reg.meterSerial || null, mismatchChecked: false });
          if (reg.ldz && !m.ldz) out.ldz = reg.ldz;
          if (reg.profile && !m.profile && !m.profileClass) out.profileClass = reg.profile;
          if (reg.supplierCode && !reg.supplierName) out.registryNote = `Registry code ${reg.supplierCode}${reg.registryName ? ` (${reg.registryName})` : ''} isn't in Troo's supplier list yet`;
          if (reg.postcodeCheck === 'mismatch') { out.address = m.address || reg.address; out.postcode = m.postcode || reg.postcode; }
        } else if (reg.status === 'not_found') out.registryNote = `${m.fuel === 'Gas' ? 'Xoserve' : 'Electralink'} has no record of this meter number`;
        else if (reg.status === 'error') out.registryNote = `Registry lookup failed: ${reg.message}`;
        if (!out.supplier) out.supplier = out.registrySupplier || m.billSupplierMatch || x.existing?.supplier || null;
        if (!out.postcode && x.existing?.postcode) out.postcode = x.existing.postcode;
        const ex = x.existing; // pricing data already on the meter in HubSpot fills what the bill or Excel didn't give
        if (ex) {
          if (!out.profile && !out.profileClass && ex.profile) out.profileClass = ex.profile;
          if (!out.meterType && !out.rates && ex.meterType) out.meterType = ex.meterType;
          if (!out.annualKwh && ex.annualKwh) out.annualKwh = ex.annualKwh;
          if (!out.ldz && ex.ldz) out.ldz = ex.ldz;
          if (!out.kva && ex.kva) out.kva = ex.kva;
          if (!out.voltage && ex.voltage) out.voltage = ex.voltage;
          if (!out.ced && ex.ced) out.ced = String(ex.ced).slice(0, 10);
        }
        return out;
      });
      setMeters(next); setProgress(100);
      setStep(3);
      await saveDraft(next, files);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); setStep(3); }
    setBusy('');
  };

  // 5. Preview from the same rules Add to HubSpot uses, then write
  const toPreview = async () => {
    setError(''); setBusy('Working out the deals'); setStep(4); setResult(null);
    try {
      const r = unwrap<Preview>(await hubspot.serverless('mc_commit', { parameters: { dealId, meters, futureStage, by: userName, preview: true } }));
      if (r.error) throw new Error(r.error);
      setPreview(r);
      await saveDraft(meters, files);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy('');
  };
  const commit = async () => {
    setError(''); setBusy('Adding to HubSpot');
    try {
      const r = unwrap<Result>(await hubspot.serverless('mc_commit', { parameters: { dealId, meters, futureStage, by: userName } }));
      if (r.error) throw new Error(r.error);
      setResult(r);
      memory.delete(dealId);
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    setBusy('');
  };

  const restart = () => { setStep(0); setFiles([]); setMeters([]); setLog([]); setProblems([]); setPreview(null); setResult(null); setError(''); saveDraft([], []); };
  const addManual = () => {
    const digits = manual.number.replace(/\D/g, '');
    if (!digits) return;
    setMeters((ms) => mergeMeters([...ms, { number: digits.length === 21 ? digits.slice(8) : digits, topLine: digits.length === 21 ? digits.slice(0, 8) : undefined,
      profile: digits.length === 21 ? digits.slice(0, 2) : undefined, fuel: manual.fuel as Fuel, valid: true, ced: manual.ced, source: 'Manual' }]));
    setManual({ number: '', fuel: manual.fuel, ced: null });
  };
  const recordUrl = (type: string, id: string) => `https://app-eu1.hubspot.com/contacts/${portalId}/record/${type}/${id}`;

  if (error && !ctx) return <Alert title="Meter Capture couldn't start" variant="error">{error}</Alert>;
  if (!ctx) return <LoadingSpinner label="Loading the deal" />;

  const included = meters.filter((m) => m.included !== false);
  const allReady = meters.length > 0 && meters.every(ready);
  const supplierOptions = ctx.suppliers.map((s) => ({ value: s, label: s }));
  const draftMeters = ctx.draft?.meters || [];

  return (
    <Flex direction="column" gap="md">
      <Flex direction="row" justify="between" align="center">
        <Flex direction="row" gap="sm" align="center">
          <Heading>Meter Capture</Heading>
          <Tag variant={ctx.deal.status === 'Complete' ? 'success' : ctx.deal.status === 'In progress' ? 'info' : 'default'}>{result ? 'Complete' : ctx.deal.status}</Tag>
          {env === 'sandbox' ? <Tag variant="warning">Sandbox</Tag> : null}
        </Flex>
        {step > 0 || result ? <Button size="xs" variant="secondary" onClick={restart}>Start again</Button> : null}
      </Flex>
      <StepIndicator stepNames={STEPS} currentStep={result ? 5 : step} />
      {ctx.notes.map((n) => <Alert key={n} title="" variant="warning">{n}</Alert>)}
      {error ? <Alert title="Something needs attention" variant="error">{error}</Alert> : null}

      {step === 0 ? (
        <Flex direction="column" gap="sm">
          {ctx.deal.status === 'Complete' && !result ? (
            <Alert title="Already captured" variant="info">Meters were added on {uk(ctx.deal.completedOn)}. Running it again updates the same meters and split deals; nothing is duplicated.</Alert>
          ) : null}
          {draftMeters.length && !meters.length ? (
            <Alert title="A capture was started earlier" variant="info">
              <Flex direction="row" gap="sm" align="center">
                <Text>{draftMeters.length} meter{draftMeters.length === 1 ? '' : 's'} saved {ctx.draft?.savedAt ? `on ${uk(ctx.draft.savedAt.slice(0, 10))}` : ''}.</Text>
                <Button size="xs" onClick={() => { setMeters(draftMeters); setFiles(ctx.draft?.files || []); setStep(3); }}>Carry on</Button>
              </Flex>
            </Alert>
          ) : null}
          <Text>Add bills (PDF or photo, up to 10) and/or the Excel meter list. They're stored on the deal as evidence.</Text>
          {!ctx.features.billReading ? <Alert title="Bill reading is not switched on yet" variant="warning">Use the Excel template or add meters by hand below. Bills you upload are still kept on the deal.</Alert> : null}
          <FileUpload fileLimit={10} attachToRecord={{ objectType: 'deals', objectId: Number(dealId) }}
            allowedFileExtensions={[...BILL_EXT, ...SHEET_EXT]}
            onChange={(fs) => setFiles(fs.map((f) => ({ id: f.id, name: f.name, extension: f.extension, size: f.size })))} />
          <Text variant="microcopy"><Text inline format={{ fontWeight: 'bold' }}>Excel template:</Text> three columns only: MPAN / MPRN, Fuel (Electricity or Gas), Contract end date (DD/MM/YYYY). Site, address and supplier come from the registry or the bill.</Text>
          <Divider />
          <Text format={{ fontWeight: 'demibold' }}>Or add a meter by hand</Text>
          <Flex direction="row" gap="sm" align="end">
            <Input name="mn" label="MPAN / MPRN" value={manual.number} onChange={(v) => setManual({ ...manual, number: v })} />
            <Select name="mf" label="Fuel" value={manual.fuel} options={[{ value: 'Elec', label: 'Electricity' }, { value: 'Gas', label: 'Gas' }]} onChange={(v) => setManual({ ...manual, fuel: String(v) })} />
            <DateInput name="mc" label="Contract end date" format="L" value={toDate(manual.ced)} onChange={(v) => setManual({ ...manual, ced: fromDate(v as DateVal | null) })} />
            <Button onClick={addManual} disabled={!manual.number.trim()}>Add</Button>
          </Flex>
          {meters.filter((m) => m.source === 'Manual').map((m) => <Text key={m.number}>{label(m)} {m.number} {m.ced ? `· CED ${uk(m.ced)}` : ''}</Text>)}
          <Flex direction="row" justify="end">
            <Button variant="primary" disabled={!files.length && !meters.length}
              onClick={() => (files.length ? readFiles() : lookUp(mergeMeters(meters)))}>{files.length ? 'Read files' : 'Check meters'}</Button>
          </Flex>
        </Flex>
      ) : null}

      {step === 1 || step === 2 ? (
        <Flex direction="column" gap="sm">
          <Text>{step === 1 ? 'Each bill is read, then its meter numbers and latest rates are checked a second time. Excel rows are read directly.' : 'Checking each meter with the registry and against meters already in HubSpot.'}</Text>
          <ProgressBar value={progress} showPercentage={false} title={busy || 'Done'} />
          {log.map((l, i) => <Text key={i}>✓ {l}</Text>)}
          {problems.map((p) => <Alert key={p} title="" variant="warning">{p}</Alert>)}
          {!busy && !meters.length ? <Flex direction="row" gap="sm"><Button onClick={() => setStep(0)}>Back</Button></Flex> : null}
        </Flex>
      ) : null}

      {step === 3 ? (
        <Flex direction="column" gap="sm">
          {problems.map((p) => <Alert key={p} title="" variant="warning">{p}</Alert>)}
          {!ctx.features.electralink || !ctx.features.xoserve ? (
            <Alert title="Registry check not connected yet" variant="info">
              {[!ctx.features.electralink ? 'Electralink' : '', !ctx.features.xoserve ? 'Xoserve' : ''].filter(Boolean).join(' and ')} will confirm the supplier and address once connected. Until then, confirm the supplier from the bill or with the customer, and add the site postcode.
            </Alert>
          ) : null}
          <Text>One row per meter. Untick a meter to save it to the company but leave it off the deal.</Text>
          <Table bordered>
            <TableHead>
              <TableRow>
                <TableHeader width={40}> </TableHeader><TableHeader>Fuel</TableHeader><TableHeader>MPAN / MPRN</TableHeader><TableHeader>Contract end date</TableHeader>
                <TableHeader>Consumption</TableHeader><TableHeader>Source</TableHeader><TableHeader>Check</TableHeader>
              </TableRow>
            </TableHead>
            <TableBody>
              {meters.map((m, i) => (
                <TableRow key={`${m.number}-${i}`}>
                  <TableCell><Checkbox name={`inc${i}`} checked={m.included !== false} onChange={(v: boolean) => update(i, { included: v })} /></TableCell>
                  <TableCell><Tag variant={m.fuel === 'Gas' ? 'default' : 'info'}>{m.fuel || '?'}</Tag></TableCell>
                  <TableCell><Text>{m.number || '(none)'}</Text>{m.problem ? <Text variant="microcopy">{m.problem}</Text> : null}</TableCell>
                  <TableCell>
                    <DateInput name={`ced${i}`} label="" format="L" value={toDate(m.ced)} onChange={(v) => update(i, { ced: fromDate(v as DateVal | null), cedDayMissing: false })} />
                    {m.cedDayMissing ? <Text variant="microcopy">Printed as "{m.cedText || 'month only'}": confirm the day</Text> : null}
                  </TableCell>
                  <TableCell>{kwh(m.annualKwh)}</TableCell>
                  <TableCell><Tag>{m.source}</Tag></TableCell>
                  <TableCell>
                    {!m.valid ? <Tag variant="error">Fix meter number</Tag>
                      : m.existingId ? <Tag variant="info">In HubSpot: will link</Tag>
                      : (m.toCheck || []).length ? <Tag variant="warning">Check {(m.toCheck || []).join(', ')}</Tag>
                      : pricingGaps(m).length ? <Tag variant="warning">Needs {pricingGaps(m).join(', ')}</Tag>
                      : <Tag variant="success">Ready to price</Tag>}
                    {m.existingId && pricingGaps(m).length ? <Text variant="microcopy">Needs {pricingGaps(m).join(', ')}</Text> : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          <Heading>Confirm each meter's current supplier and site</Heading>
          {meters.map((m, i) => (m.included === false ? null : (
            <Box key={`s-${m.number}-${i}`}>
              <Flex direction="row" gap="md" wrap="wrap" align="start">
                <Flex direction="column" gap="flush">
                  <Text variant="microcopy">{label(m)}{m.files?.length ? ` · ${m.files.join(', ')}` : ''}</Text>
                  <Text format={{ fontWeight: 'bold' }}>{m.number}</Text>
                  {m.rates && (m.rates.day != null || m.rates.unit != null) ? (
                    <Text variant="microcopy">Rates: {m.rates.day != null ? `Day ${m.rates.day}p` : ''}{m.rates.night != null ? ` · Night ${m.rates.night}p` : ''}{m.rates.unit != null ? `Unit ${m.rates.unit}p` : ''}{m.rates.standing_charge != null ? ` · SC ${m.rates.standing_charge}p/day` : ''}{m.rates.rates_from ? ` (from ${uk(m.rates.rates_from)})` : ''}</Text>
                  ) : null}
                </Flex>
                <Flex direction="column" gap="xs">
                  <Text variant="microcopy">On the bill: {m.billSupplier || 'no bill'}{m.existingSupplier ? ` · In HubSpot: ${m.existingSupplier}` : ''}</Text>
                  <Text variant="microcopy">On the registry: {m.registrySupplier ? `${m.registrySupplier}${m.registrySince ? ` since ${uk(m.registrySince)}` : ''}` : m.registryNote || 'not checked'}</Text>
                  {m.registrySupplier && m.billSupplierMatch && m.registrySupplier !== m.billSupplierMatch ? <Tag variant="warning">Bill and registry differ: possible recent switch</Tag> : null}
                  {mismatch(m) ? (
                    <Flex direction="column" gap="xs">
                      <Tag variant="error">Registry address is somewhere else: {m.registryAddress || ''} {m.registryPostcode || ''}</Tag>
                      <Text variant="microcopy">The meter number may be misread. Check it against the bill before saving.</Text>
                      <Checkbox name={`mm${i}`} checked={!!m.mismatchChecked} onChange={(v: boolean) => update(i, { mismatchChecked: v })}>I've checked the meter number is right</Checkbox>
                    </Flex>
                  ) : m.registryCheck === 'match' ? <Tag variant="success">Registry address matches</Tag> : null}
                </Flex>
                <Flex direction="column" gap="xs">
                  <Select name={`sup${i}`} label="Current supplier to save" required value={m.supplier || ''} options={supplierOptions}
                    onChange={(v) => update(i, { supplier: String(v) })} />
                  {reasonNeeded(m) ? <Input name={`why${i}`} label="Reason for changing the registry supplier" required value={m.overrideReason || ''} onChange={(v) => update(i, { overrideReason: v })} /> : null}
                </Flex>
                <Flex direction="column" gap="xs">
                  <Input name={`pc${i}`} label="Site postcode" value={m.postcode || ''} onChange={(v) => update(i, { postcode: v.toUpperCase() })} />
                  <Input name={`ad${i}`} label="Site address" value={m.address || ''} onChange={(v) => update(i, { address: v })} />
                </Flex>
                {pricingGaps(m).length ? (
                  <Flex direction="column" gap="xs">
                    <Text variant="microcopy" format={{ fontWeight: 'bold' }}>For pricing</Text>
                    {!(Number(m.annualKwh) > 0) ? <NumberInput name={`kwh${i}`} label="Annual consumption (kWh)" min={0} value={m.annualKwh ?? undefined} onChange={(v: number) => update(i, { annualKwh: v })} /> : null}
                    {m.fuel === 'Gas' && !m.ldz ? <Select name={`ldz${i}`} label="Gas zone (LDZ)" value={m.ldz || ''} options={LDZ} onChange={(v) => update(i, { ldz: String(v) })} /> : null}
                    {m.fuel !== 'Gas' && !m.profile ? <Select name={`pc${i}x`} label="Profile class" value={m.profileClass || ''} options={PROFILE_OPTS} onChange={(v) => update(i, { profileClass: String(v) })} /> : null}
                    {m.fuel !== 'Gas' && profileOf(m) && profileOf(m) !== '00' && !typeOf(m) ? <Select name={`mt${i}`} label="Meter type" value={m.meterType || ''} options={METER_TYPES} onChange={(v) => update(i, { meterType: String(v) })} /> : null}
                    {profileOf(m) === '00' ? <NumberInput name={`kva${i}`} label="Capacity (kVA)" min={0} value={m.kva ?? undefined} onChange={(v: number) => update(i, { kva: v })} /> : null}
                    {profileOf(m) === '00' ? <Select name={`hv${i}`} label="HH voltage" value={m.voltage || ''} options={VOLTAGES} onChange={(v) => update(i, { voltage: String(v) })} /> : null}
                    <Text variant="microcopy">Leave blank if you don't know yet: the deal can't go to RFQ until it's filled in.</Text>
                  </Flex>
                ) : null}
              </Flex>
              <Divider />
            </Box>
          )))}
          <Flex direction="row" gap="sm" justify="end" align="center">
            {!allReady ? <Text variant="microcopy">Every ticked meter needs a valid number and a supplier (and a reason if it differs from the registry, and a check where the registry address is elsewhere).</Text>
              : included.some((m) => pricingGaps(m).length) ? <Text variant="microcopy">{included.filter((m) => pricingGaps(m).length).length} meter(s) still need data for pricing. You can add them now and fill the gaps later.</Text> : null}
            <Button onClick={() => setStep(0)}>Back</Button>
            <Button variant="primary" disabled={!allReady || !included.length && !meters.length} onClick={toPreview}>Continue</Button>
          </Flex>
        </Flex>
      ) : null}

      {step === 4 ? (
        <Flex direction="column" gap="sm">
          {busy ? <LoadingSpinner label={busy} /> : null}
          {preview && !result ? (
            <>
              <Text>Meters are bunched by fuel and contract end date. Add to HubSpot writes everything in one go. No Contract records are created.</Text>
              {preview.groups.map((g) => (
                <Box key={g.key}>
                  <Flex direction="row" gap="sm" align="center">
                    <Text format={{ fontWeight: 'bold' }}>{g.kind === 'this' ? 'This deal' : g.exists ? 'Existing split deal' : 'New deal'} · {g.label}</Text>
                    <Tag variant={g.kind === 'this' ? 'success' : g.kind === 'gas' ? 'info' : 'default'}>{g.kind === 'future' ? (g.stage || 'Future Opportunity') : g.kind === 'gas' ? 'Same stage as this deal' : 'Stays here'}</Tag>
                  </Flex>
                  <Text variant="microcopy">{g.dealName} · {g.meters.length} meter{g.meters.length === 1 ? '' : 's'}: {g.meters.join(', ')}{g.earliestCed ? ` · deal CED ${uk(g.earliestCed)}` : ''}</Text>
                  {g.flags.map((f) => <Text key={f} variant="microcopy">⚠ {f}</Text>)}
                  {g.missing?.length ? <Text variant="microcopy">Data for pricing still needed (blocks RFQ): {g.missing.join('; ')}</Text>
                    : <Text variant="microcopy">✓ Every meter has the data pricing needs</Text>}
                </Box>
              ))}
              <Statistics>
                <StatisticsItem label="New sites" number={String(preview.sites.new)} />
                <StatisticsItem label="Existing sites" number={String(preview.sites.matched)} />
                <StatisticsItem label="New meters" number={String(preview.meters.new)} />
                <StatisticsItem label="Existing meters linked" number={String(preview.meters.existing)} />
              </Statistics>
              {preview.meters.unticked ? <Text>{preview.meters.unticked} unticked meter{preview.meters.unticked === 1 ? '' : 's'} will be saved to the company only.</Text> : null}
              {preview.warnings.map((w) => <Alert key={w} title="" variant="warning">{w}</Alert>)}
              <Flex direction="row" gap="sm" justify="end">
                <Button onClick={() => setStep(3)} disabled={!!busy}>Back</Button>
                <Button variant="primary" onClick={commit} disabled={!!busy}>Add to HubSpot</Button>
              </Flex>
            </>
          ) : null}
          {result ? (
            <>
              <Alert title="Added to HubSpot" variant="success">
                {result.sites.created} new site{result.sites.created === 1 ? '' : 's'}, {result.meters.created} new meter{result.meters.created === 1 ? '' : 's'}, {result.meters.updated} existing meter{result.meters.updated === 1 ? '' : 's'} updated. The files stay on the deal.
              </Alert>
              {result.deals.map((d) => (
                <Flex key={d.key} direction="row" gap="sm" align="center">
                  <Tag variant={d.kind === 'this' ? 'success' : 'info'}>{d.kind === 'this' ? 'This deal' : d.created ? 'New deal' : 'Split deal'}</Tag>
                  {d.kind === 'this' ? <Text>{d.label}: {d.meters.length} meter{d.meters.length === 1 ? '' : 's'}</Text>
                    : <Link href={{ url: recordUrl('0-3', String(d.dealId)), external: true }}>{d.label}: {d.meters.length} meter{d.meters.length === 1 ? '' : 's'}</Link>}
                  <Tag variant={d.dataComplete ? 'success' : 'warning'}>{d.dataComplete ? 'Meter data complete' : 'Meter data missing'}</Tag>
                  {d.stageNote ? <Text variant="microcopy">{d.stageNote}</Text> : null}
                </Flex>
              ))}
              {result.warnings.map((w) => <Alert key={w} title="" variant="warning">{w}</Alert>)}
              <Text variant="microcopy">Refresh the page to see the new meters and sites in the record sidebar.</Text>
            </>
          ) : null}
          {!preview && !busy && !result ? <EmptyState title="Nothing to show" layout="vertical"><Button onClick={() => setStep(3)}>Back</Button></EmptyState> : null}
        </Flex>
      ) : null}
    </Flex>
  );
};
