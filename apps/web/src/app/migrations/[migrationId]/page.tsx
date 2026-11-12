import { MigrationView } from '../../../features/migrations/migration-view';

export default async function MigrationPage({
  params,
}: {
  params: Promise<{ migrationId: string }>;
}) {
  const { migrationId } = await params;
  return <MigrationView migrationId={migrationId} />;
}
