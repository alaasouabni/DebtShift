import type { Metadata } from 'next';

import { RoutesView } from '../../features/routes/routes-view';

export const metadata: Metadata = { title: 'Route comparison' };

export default function RoutesPage() {
  return <RoutesView />;
}
