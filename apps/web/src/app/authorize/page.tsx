import type { Metadata } from 'next';

import { AuthorizeView } from '../../features/authorization/authorize-view';

export const metadata: Metadata = { title: 'Authorization' };

export default function AuthorizePage() {
  return <AuthorizeView />;
}
