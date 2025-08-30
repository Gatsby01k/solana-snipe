
export async function fetchPair(chainId: string, pairAddress: string){
  const url = `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(chainId)}/${encodeURIComponent(pairAddress)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Dexscreener HTTP ${res.status}`);
  const j = await res.json();
  const pair = (j?.pairs && j.pairs[0]) || null;
  return pair;
}
