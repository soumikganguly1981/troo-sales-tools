// Pricing: one deal tab with two sub-tabs, Instant Quote (matrix prices) and Customer quote
// (the shortlist and the quote PDF). The two share the deal's shortlist, so ticking an option
// on one updates the other.
import React, { useCallback, useState } from 'react';
import { Flex, Tab, Tabs, hubspot } from '@hubspot/ui-extensions';
import type { CrmContext, ExtensionPointApiActions } from '@hubspot/ui-extensions';
import { MatrixPricing } from './MatrixPricing.tsx';
import { CustomerQuote } from './CustomerQuote.tsx';

interface Props {
  context: CrmContext;
  actions: ExtensionPointApiActions<'crm.record.tab'>;
}

const Pricing = ({ dealId, userName }: { dealId: string; userName: string }) => {
  const [tab, setTab] = useState('instant');
  const [count, setCount] = useState<number | null>(null);
  const [quoteVersion, setQuoteVersion] = useState(0);
  const [matrixVersion, setMatrixVersion] = useState(0);

  // A tick in Instant Quote refreshes the Customer quote list; a change in Customer quote
  // (remove, clear, save) refreshes the ticks. Plain reloads only update the count.
  const fromInstant = useCallback((n: number, changed: boolean) => { setCount(n); if (changed) setQuoteVersion((v) => v + 1); }, []);
  const fromQuote = useCallback((n: number, changed: boolean) => { setCount(n); if (changed) setMatrixVersion((v) => v + 1); }, []);

  // The Tabs are only the header: content placed inside a Tab didn't update on first load
  // until a tab was clicked, so the active sub-tab is rendered below them instead.
  return (
    <Flex direction="column" gap="md">
      <Tabs variant="enclosed" defaultSelected="instant" onSelectedChange={(id: string | number) => setTab(String(id))}>
        <Tab tabId="instant" title="Instant Quote" />
        <Tab tabId="quote" title={count ? `Customer quote (${count})` : 'Customer quote'} />
      </Tabs>
      {tab === 'instant'
        ? <MatrixPricing dealId={dealId} userName={userName} shortlistVersion={matrixVersion} onShortlist={fromInstant} />
        : <CustomerQuote dealId={dealId} userName={userName} version={quoteVersion} onShortlist={fromQuote} />}
    </Flex>
  );
};

hubspot.extend<'crm.record.tab'>(({ context }: Props) => (
  <Pricing dealId={String(context.crm.objectId)} userName={[context.user?.firstName, context.user?.lastName].filter(Boolean).join(' ')} />
));
