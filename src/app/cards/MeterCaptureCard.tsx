// Meter Capture deal tab. The work is in MeterCapture.tsx.
import React from 'react';
import { hubspot } from '@hubspot/ui-extensions';
import type { CrmContext } from '@hubspot/ui-extensions';
import { MeterCapture } from './MeterCapture.tsx';

hubspot.extend<'crm.record.tab'>(({ context }: { context: CrmContext }) => <MeterCapture context={context} />);
