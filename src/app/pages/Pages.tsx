import React from 'react';
import { hubspot, Text } from '@hubspot/ui-extensions';
import type { ExtensionPointApiActions, PagesContext } from '@hubspot/ui-extensions';
import { createPageRouter, PageBreadcrumbs, PageRoutes, PageTitle } from '@hubspot/ui-extensions/pages';
import { RevenueCalculator } from './RevenueCalculator.tsx';

interface Props {
  context: PagesContext;
  actions: ExtensionPointApiActions<'pages'>;
}

const CalculatorPage = () => (
  <>
    <PageBreadcrumbs>
      <PageBreadcrumbs.Current>Supplier revenue calculator</PageBreadcrumbs.Current>
    </PageBreadcrumbs>
    <PageTitle>Supplier revenue calculator</PageTitle>
    <Text>Ranks every supplier product by the commission it earns on a deal. To prefill from a deal and save the result, use the card on the deal record.</Text>
    <RevenueCalculator />
  </>
);

const PageRouter = createPageRouter(
  <PageRoutes>
    <PageRoutes.IndexRoute component={CalculatorPage} />
  </PageRoutes>,
);

hubspot.extend<'pages'>((_props: Props) => <PageRouter />);
