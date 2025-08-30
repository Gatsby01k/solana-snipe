import { Connection, PublicKey } from "@solana/web3.js";

export async function getTokenBalanceLamports(conn: Connection, owner: PublicKey, mint: PublicKey): Promise<{amount: bigint, decimals: number}> {
  // NOTE: третий аргумент — Commitment, передаём просто строку
  const resp = await conn.getParsedTokenAccountsByOwner(owner, { mint }, "confirmed");
  let lamports = 0n;
  let decimals = 0;
  for (const a of resp.value) {
    const info: any = a.account.data.parsed.info;
    const tokenAmount = info.tokenAmount;
    decimals = tokenAmount.decimals ?? decimals;
    lamports += BigInt(tokenAmount.amount);
  }
  return { amount: lamports, decimals };
}
