import { and, eq, gt, isNull } from 'drizzle-orm';

import type { DebtShiftDatabase } from './client.js';
import { walletAuthChallenges, walletSessions } from './schema.js';

export interface StoreWalletAuthChallengeInput {
  readonly challengeId: string;
  readonly walletAddress: string;
  readonly chainId: string;
  readonly nonce: string;
  readonly message: string;
  readonly expiresAt: Date;
}

export interface CreateWalletSessionInput {
  readonly challengeId: string;
  readonly sessionHash: string;
  readonly walletAddress: string;
  readonly chainId: string;
  readonly expiresAt: Date;
  readonly now: Date;
}

export async function storeWalletAuthChallenge(
  database: DebtShiftDatabase,
  input: StoreWalletAuthChallengeInput,
) {
  const [stored] = await database.insert(walletAuthChallenges).values(input).returning();
  if (stored === undefined) throw new Error('Wallet authentication challenge was not stored.');
  return stored;
}

export async function getWalletAuthChallenge(database: DebtShiftDatabase, challengeId: string) {
  const [challenge] = await database
    .select()
    .from(walletAuthChallenges)
    .where(eq(walletAuthChallenges.challengeId, challengeId))
    .limit(1);
  return challenge;
}

export async function consumeWalletAuthChallenge(
  database: DebtShiftDatabase,
  input: CreateWalletSessionInput,
) {
  return database.transaction(async (transaction) => {
    const [challenge] = await transaction
      .update(walletAuthChallenges)
      .set({ consumedAt: input.now })
      .where(
        and(
          eq(walletAuthChallenges.challengeId, input.challengeId),
          eq(walletAuthChallenges.walletAddress, input.walletAddress),
          eq(walletAuthChallenges.chainId, input.chainId),
          isNull(walletAuthChallenges.consumedAt),
          gt(walletAuthChallenges.expiresAt, input.now),
        ),
      )
      .returning();
    if (challenge === undefined) {
      throw new Error('Wallet authentication challenge is expired, mismatched, or already used.');
    }

    const [session] = await transaction
      .insert(walletSessions)
      .values({
        sessionHash: input.sessionHash,
        walletAddress: input.walletAddress,
        chainId: input.chainId,
        expiresAt: input.expiresAt,
        lastSeenAt: input.now,
      })
      .returning();
    if (session === undefined) throw new Error('Wallet session was not stored.');
    return session;
  });
}

export async function touchActiveWalletSession(
  database: DebtShiftDatabase,
  sessionHash: string,
  now: Date,
) {
  const [session] = await database
    .update(walletSessions)
    .set({ lastSeenAt: now })
    .where(
      and(
        eq(walletSessions.sessionHash, sessionHash),
        isNull(walletSessions.revokedAt),
        gt(walletSessions.expiresAt, now),
      ),
    )
    .returning();
  return session;
}

export async function revokeWalletSession(
  database: DebtShiftDatabase,
  sessionHash: string,
  now: Date,
): Promise<boolean> {
  const [session] = await database
    .update(walletSessions)
    .set({ revokedAt: now, lastSeenAt: now })
    .where(and(eq(walletSessions.sessionHash, sessionHash), isNull(walletSessions.revokedAt)))
    .returning({ sessionHash: walletSessions.sessionHash });
  return session !== undefined;
}
