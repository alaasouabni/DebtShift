import type { Metadata } from 'next';

import { PositionView } from '../../features/positions/position-view';

export const metadata: Metadata = { title: 'Your position' };

export default function PositionPage() {
  return <PositionView />;
}
