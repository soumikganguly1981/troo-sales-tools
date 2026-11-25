import React from 'react';
import { hubspot } from '@hubspot/ui-extensions';
import type { CrmContext, ExtensionPointApiActions } from '@hubspot/ui-extensions';
import { CustomerQuote } from './CustomerQuote.tsx';

interface Props {
  context: CrmContext;
  actions: ExtensionPointApiActions<'crm.record.tab'>;
}

hubspot.extend<'crm.record.tab'>(({ context }: Props) => (
  <CustomerQuote dealId={String(context.crm.objectId)} userName={[context.user?.firstName, context.user?.lastName].filter(Boolean).join(' ')} />
));
