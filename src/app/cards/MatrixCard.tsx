import React from 'react';
import { hubspot } from '@hubspot/ui-extensions';
import type { CrmContext, ExtensionPointApiActions } from '@hubspot/ui-extensions';
import { MatrixPricing } from './MatrixPricing.tsx';

interface Props {
  context: CrmContext;
  actions: ExtensionPointApiActions<'crm.record.tab'>;
}

hubspot.extend<'crm.record.tab'>(({ context }: Props) => (
  <MatrixPricing dealId={String(context.crm.objectId)} />
));
