
import { Connection, PublicKey } from "@solana/web3.js";

export type MintRisk = { mintAuthorityNull: boolean; freezeAuthorityNull: boolean; };

export async function getMintRisk(conn: Connection, mintStr: string): Promise<MintRisk> {
  const mint = new PublicKey(mintStr);
  const acc = await conn.getParsedAccountInfo(mint, "confirmed");
  const parsed: any = acc.value?.data?.parsed;
  const info = parsed?.info;
  const mintAuthNull = !info?.mintAuthority;
  const freezeNull = !info?.freezeAuthority;
  return { mintAuthorityNull: !!mintAuthNull, freezeAuthorityNull: !!freezeNull };
}
