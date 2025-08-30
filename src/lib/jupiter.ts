
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";

export const WSOL = "So11111111111111111111111111111111111111112";

export type Quote = {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  slippageBps: number;
  priceImpactPct: number;
  routePlan: any[];
};

export async function getQuote(inputMint: string, outputMint: string, amount: number, slippageBps: number): Promise<Quote> {
  const url = new URL("https://quote-api.jup.ag/v6/quote");
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", String(Math.floor(amount)));
  url.searchParams.set("slippageBps", String(Math.floor(slippageBps)));
  url.searchParams.set("onlyDirectRoutes", "false");
  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Quote HTTP ${res.status}`);
  const data = await res.json();
  if (!data || !data.outAmount) throw new Error("No routes");
  return data as Quote;
}

export async function getSwapTx(opts: {
  quote: Quote,
  userPublicKey: PublicKey,
  wrapAndUnwrapSol?: boolean,
  prioritizationFeeLamports?: number
}): Promise<VersionedTransaction> {
  const res = await fetch("https://quote-api.jup.ag/v6/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: opts.quote,
      userPublicKey: opts.userPublicKey.toBase58(),
      wrapAndUnwrapSol: opts.wrapAndUnwrapSol ?? true,
      useSharedAccounts: true,
      asLegacyTransaction: false,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: Math.floor(opts.prioritizationFeeLamports || 0)
    })
  });
  if (!res.ok) throw new Error(`Swap HTTP ${res.status}`);
  const j = await res.json();
  const swapTx = j.swapTransaction;
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTx, "base64"));
  return tx;
}

export async function sendAndConfirm(conn: Connection, tx: VersionedTransaction, signAndSend: (tx: VersionedTransaction)=>Promise<string>, commitment: "processed"|"confirmed"|"finalized" = "confirmed"): Promise<string> {
  const sig = await signAndSend(tx);
  try {
    const latest = await conn.getLatestBlockhash();
    await conn.confirmTransaction({ signature: sig, ...latest }, commitment);
  } catch(e) { /* ignore confirm failure */ }
  return sig;
}

export async function simulateTx(conn: Connection, tx: VersionedTransaction): Promise<{err:any, logs?:string[]}> {
  const res = await conn.simulateTransaction(tx, { sigVerify: false });
  return { err: (res as any).value.err, logs: (res as any).value.logs };
}
