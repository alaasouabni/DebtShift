import type { Metadata } from 'next';

import { MigrationView } from '../../../features/migrations/migration-view';

export const metadata: Metadata = { title: 'Migration monitor' };

export default async function MigrationPage({
  params,
}: {
  params: Promise<{ migrationId: string }>;
}) {
  const { migrationId } = await params;
  return <MigrationView migrationId={migrationId} />;
}
