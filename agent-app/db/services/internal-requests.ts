import { lt, sql } from "drizzle-orm";
import { db, internalRequestReceipts } from "@db";

export async function claimInternalRequest(
  receipt: typeof internalRequestReceipts.$inferInsert,
  now = new Date()
) {
  if (receipt.expiresAt.getTime() <= now.getTime()) return false;
  return db.transaction(async (transaction) => {
    // Bound maintenance work; expired receipts cannot authenticate a current request.
    await transaction.delete(internalRequestReceipts)
      .where(sql`${internalRequestReceipts.requestId} IN (
      SELECT ${internalRequestReceipts.requestId} FROM ${internalRequestReceipts}
      WHERE ${lt(internalRequestReceipts.expiresAt, now)} LIMIT 100
    )`);
    const [inserted] = await transaction
      .insert(internalRequestReceipts)
      .values(receipt)
      .onConflictDoNothing()
      .returning({ requestId: internalRequestReceipts.requestId });
    return inserted !== undefined;
  });
}
