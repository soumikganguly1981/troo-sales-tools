import React from 'react';
import { hubspot } from '@hubspot/ui-extensions';
import type { CrmContext, ExtensionPointApiActions } from '@hubspot/ui-extensions';
import { RevenueCalculator } from './RevenueCalculator.tsx';

interface Props {
  context: CrmContext;
  actions: ExtensionPointApiActions<'crm.record.tab'>;
}

hubspot.extend<'crm.record.tab'>(({ context }: Props) => (
  <RevenueCalculator dealId={String(context.crm.objectId)} />
));
