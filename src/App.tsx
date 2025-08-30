/* eslint-disable @typescript-eslint/no-explicit-any */
import React, { useEffect, useMemo, useState } from "react";
import { LineChart, Line, ResponsiveContainer } from "recharts";
import { Play, Pause, Rocket, Wallet, ShieldCheck, ShieldAlert, Ban, DollarSign, Upload, Download } from "lucide-react";
import { Connection, LAMPORTS_PER_SOL, clusterApiUrl, PublicKey } from "@solana/web3.js";
import { ConnectionProvider, WalletProvider, useWallet } from "@solana/wallet-adapter-react";
import { WalletModalProvider, WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
  GlowWalletAdapter,
  ExodusWalletAdapter,
  LedgerWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import { getQuote, getSwapTx, sendAndConfirm, WSOL, simulateTx } from "./lib/jupiter";
import { getTokenBalanceLamports } from "./lib/tokens";
import { getMintRisk } from "./lib/risk";
import { fetchPair } from "./lib/dex";

const glass = "backdrop-blur-xl bg-white/5 border border-white/10 shadow-xl";
const pill = "px-3 py-1 rounded-full text-xs font-medium border border-white/10 bg-white/5";

type DexPair = {
  chainId?: string;
  pairAddress?: string;
  dexId?: string;
  baseToken?: { address?: string; symbol?: string };
  quoteToken?: { address?: string; symbol?: string };
  priceUsd?: string;
  fdv?: number;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { m5?: number; h1?: number; h6?: number; h24?: number };
  pairCreatedAt?: number;
};

type Ladder = { levels: number[]; parts: number[]; armed: boolean; entryUsd?: number; executed?: boolean[]; pairAddress?: string; chainId?: string };

function useLocal<T>(key: string, init: T) {
  const [v, setV] = useState<T>(() => { try{ const raw=localStorage.getItem(key); return raw? JSON.parse(raw) as T : init; }catch{ return init; } });
  useEffect(()=>{ try{ localStorage.setItem(key, JSON.stringify(v)); }catch{} },[key,v]);
  return [v,setV] as const;
}

export default function App(): JSX.Element {
  const [endpoint, setEndpoint] = useLocal<string>("rpc", clusterApiUrl("mainnet-beta"));
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
      new GlowWalletAdapter(),
      new ExodusWalletAdapter(),
      new LedgerWalletAdapter(),
    ],
    []
  );
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <Root endpoint={endpoint} setEndpoint={setEndpoint}/>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

function Root({endpoint, setEndpoint}:{endpoint:string; setEndpoint:(s:string)=>void}){
  const [live, setLive] = useState<{t:number;p:number}[]>([]);
  const [run, setRun] = useState(true);

  const [autoScan, setAutoScan] = useLocal<boolean>("auto", true);
  const [scanSec, setScanSec] = useLocal<number>("scanSec", 12);
  const [recentOnlyMins, setRecentOnlyMins] = useLocal<number>("recentOnly", 90);
  const [minLiq, setMinLiq] = useLocal<number>("minLiq", 4000);
  const [minVol, setMinVol] = useLocal<number>("minVol", 10000);
  const [maxFdv, setMaxFdv] = useLocal<number>("maxFdv", 600000);
  const [minH1, setMinH1] = useLocal<number>("minH1", -5);
  const [maxH1, setMaxH1] = useLocal<number>("maxH1", 40);
  const [autoRows, setAutoRows] = useState<DexPair[]>([]);
  const [lastScanAt, setLastScanAt] = useState<number | null>(null);

  // trading
  const [slippageBps, setSlippageBps] = useLocal<number>("slip", 350);
  const [buySol, setBuySol] = useLocal<number>("buySol", 0.1);
  const [sellPct, setSellPct] = useLocal<number>("sellPct", 25);
  const [maxImpactPct, setMaxImpactPct] = useLocal<number>("maxImpact", 12);
  const [prioFee, setPrioFee] = useLocal<number>("prio", 2500);
  const [commitment, setCommitment] = useLocal<"processed"|"confirmed"|"finalized">("commit","confirmed");
  const [status, setStatus] = useState<string>("");
  const [preSim, setPreSim] = useLocal<boolean>("presim", true);

  // access
  const conn = useMemo(()=> new Connection(endpoint, "confirmed"), [endpoint]);
  const { publicKey, sendTransaction, connected } = useWallet();

  // lists
  const [wl, setWl] = useLocal<string[]>("wl", []);
  const [bl, setBl] = useLocal<string[]>("bl", []);

  // per-mint TP ladders
  const [ladders, setLadders] = useLocal<Record<string, Ladder>>("ladders", {});

  // sparkline demo
  useEffect(()=>{
    if (!run) return; let p = Math.random()*0.01+0.001; const id=setInterval(()=>{ p=Math.max(0.0001, p*(1+(Math.random()-0.5)*0.2)); setLive((old)=>[...old.slice(-120),{t:Date.now(),p}]); },900); return ()=>clearInterval(id);
  },[run]);

  // scanning
  function clamp(n:number,min:number,max:number){ return Math.min(max, Math.max(min,n)); }
  function scoreRow(r: DexPair): number {
    const now = Date.now();
    const ageMin = r.pairCreatedAt? (now - r.pairCreatedAt)/60000 : 9999;
    const ageScore = clamp(1 - Math.min(ageMin, 240)/240, 0, 1);
    const liq = r.liquidity?.usd ?? 0; const vol = r.volume?.h24 ?? 0; const fdv = r.fdv ?? 0;
    const liqScore = clamp(Math.log10(1+liq)/5, 0, 1);
    const volScore = clamp(Math.log10(1+vol)/6, 0, 1);
    const fdvScore = fdv<=0? 0.6 : clamp(1 - Math.log10(Math.max(1,fdv))/7, 0, 1);
    const ch = r.priceChange?.h1 ?? 0;
    const mom = ch<=0 ? 0 : ch>80 ? 0.2 : 0.6 + 0.4*(1 - ch/80);
    const total = 0.25*ageScore + 0.25*liqScore + 0.25*volScore + 0.15*fdvScore + 0.10*mom;
    return Number((total*100).toFixed(1));
  }
  async function scanSolana(): Promise<void> {
    try {
      const res = await fetch('https://api.dexscreener.com/latest/dex/pairs/solana');
      if (!res.ok) throw new Error(`Dexscreener HTTP ${res.status}`);
      const data = await res.json();
      let rows: DexPair[] = (data?.pairs||[]);
      const now = Date.now();
      const mins = Math.max(0, Number(recentOnlyMins)||0);
      rows = rows.filter(r => (mins<=0 || !r.pairCreatedAt || (now - r.pairCreatedAt) <= mins*60*1000));
      rows = rows.filter(r => (typeof r.liquidity?.usd!=="number" ? true : r.liquidity!.usd >= minLiq));
      rows = rows.filter(r => (typeof r.volume?.h24!=="number" ? true : r.volume!.h24 >= minVol));
      rows = rows.filter(r => (typeof r.fdv!=="number" ? true : r.fdv! <= maxFdv));
      rows = rows.filter(r => { const ch = r.priceChange?.h1; if (typeof ch!=="number") return true; return ch>=minH1 && ch<=maxH1; });
      rows = rows.filter(r => {
        const key = (r.baseToken?.address || "").toLowerCase();
        if (bl.some(x=>x.toLowerCase()===key)) return false;
        if (wl.length>0) return wl.some(x=>x.toLowerCase()===key);
        return true;
      });
      rows = rows.sort((a,b)=> scoreRow(b) - scoreRow(a)).slice(0,80);
      setAutoRows(rows);
      setLastScanAt(Date.now());
    } catch(e:any) { /* ignore */ }
  }
  useEffect(()=>{
    if (!autoScan) return;
    scanSolana();
    const ms = Math.max(5, Number(scanSec)||12) * 1000;
    const id = setInterval(scanSolana, ms);
    return ()=> clearInterval(id);
  }, [autoScan, scanSec, recentOnlyMins, minLiq, minVol, maxFdv, minH1, maxH1, wl, bl]);

  // risk checks: mint/freeze + optional pre-trade sim
  async function checkMint(mint: string){
    const r = await getMintRisk(conn, mint);
    return r;
  }
  async function preTradeSimBuy(mint: string, lamports: number){
    const q = await getQuote(WSOL, mint, lamports, slippageBps);
    const tx = await getSwapTx({ quote: q, userPublicKey: publicKey!, wrapAndUnwrapSol: true, prioritizationFeeLamports: 0 });
    const res = await simulateTx(conn, tx);
    return !res.err;
  }
  async function preTradeSimSell(mint: string, lamports: number){
    const q = await getQuote(mint, WSOL, lamports, slippageBps);
    const tx = await getSwapTx({ quote: q, userPublicKey: publicKey!, wrapAndUnwrapSol: true, prioritizationFeeLamports: 0 });
    const res = await simulateTx(conn, tx);
    return !res.err;
  }

  function needWallet(){
    if (!connected || !publicKey) throw new Error("Подключите кошелек (кнопка Connect справа вверху)");
  }

  // BUY
  async function buyBase(baseMint: string, pair?: DexPair){
    try{
      needWallet();
      setStatus("Проверки перед покупкой...");
      const mintRisk = await checkMint(baseMint);
      if (!mintRisk.mintAuthorityNull || !mintRisk.freezeAuthorityNull) throw new Error("Mint/freeze authority не сброшены");
      if (preSim) {
        const okBuy = await preTradeSimBuy(baseMint, Math.max(Math.floor(0.01 * LAMPORTS_PER_SOL), 1_000_000));
        if (!okBuy) throw new Error("Pre-sim BUY не прошёл");
      }
      setStatus("Котировка...");
      const lamports = Math.floor(buySol * LAMPORTS_PER_SOL);
      const quote = await getQuote(WSOL, baseMint, lamports, slippageBps);
      const impact = (quote.priceImpactPct||0) * 100;
      if (impact > maxImpactPct) throw new Error(`Price impact ${impact.toFixed(2)}% > лимита ${maxImpactPct}%`);
      setStatus("Транзакция...");
      const tx = await getSwapTx({ quote, userPublicKey: publicKey!, wrapAndUnwrapSol: true, prioritizationFeeLamports: prioFee });
      const sig = await sendAndConfirm(conn, tx, (t)=>sendTransaction(t, conn), commitment);
      setStatus(`Buy OK: ${sig}`);

      // arm ladder entry
      if (pair && ladders[baseMint]?.armed) {
        const entryUsd = Number(pair.priceUsd||"0");
        const next = { ...ladders };
        next[baseMint].entryUsd = entryUsd>0 ? entryUsd : undefined;
        next[baseMint].pairAddress = pair.pairAddress;
        next[baseMint].chainId = pair.chainId;
        next[baseMint].executed = (next[baseMint].executed || next[baseMint].levels.map(()=>false));
        setLadders(next);
      }
    }catch(e:any){ setStatus("Ошибка: " + (e?.message || String(e))); }
  }

  // SELL by %
  async function sellBasePct(baseMint: string, pct: number){
    try{
      needWallet();
      setStatus("Баланс токена...");
      const { amount } = await getTokenBalanceLamports(conn, publicKey!, new PublicKey(baseMint));
      if (amount <= 0n) throw new Error("Баланс токена = 0");
      const sellAmount = (amount * BigInt(Math.floor(pct))) / 100n;
      if (sellAmount <= 0) throw new Error("Слишком маленький % для продажи");
      setStatus("Котировка...");
      const quote = await getQuote(baseMint, WSOL, Number(sellAmount), slippageBps);
      const impact = (quote.priceImpactPct||0) * 100;
      if (impact > maxImpactPct) throw new Error(`Price impact ${impact.toFixed(2)}% > лимита ${maxImpactPct}%`);
      setStatus("Транзакция...");
      const tx = await getSwapTx({ quote, userPublicKey: publicKey!, wrapAndUnwrapSol: true, prioritizationFeeLamports: prioFee });
      const sig = await sendAndConfirm(conn, tx, (t)=>sendTransaction(t, conn), commitment);
      setStatus(`Sell ${pct}% OK: ${sig}`);
    }catch(e:any){ setStatus("Ошибка: " + (e?.message || String(e))); }
  }

  // Ladder automation
  useEffect(()=>{
    const id = setInterval(async ()=>{
      try{
        const keys = Object.keys(ladders);
        for (const mint of keys){
          const L = ladders[mint];
          if (!L?.armed || !L.levels?.length || !L.parts?.length || !L.pairAddress || !L.chainId || !L.entryUsd) continue;
          const pair = await fetchPair(L.chainId, L.pairAddress);
          const price = Number(pair?.priceUsd || "0");
          if (!price || price<=0) continue;
          const executed = L.executed || L.levels.map(()=>false);
          let changed = false;
          for (let i=0;i<L.levels.length;i++){
            if (executed[i]) continue;
            const target = L.entryUsd * L.levels[i];
            if (price >= target){
              await sellBasePct(mint, L.parts[i]);
              executed[i] = true;
              changed = true;
            }
          }
          if (changed){
            const next = { ...ladders };
            next[mint] = { ...L, executed };
            setLadders(next);
          }
        }
      }catch{ /* ignore */ }
    }, 15000);
    return ()=> clearInterval(id);
  }, [ladders, sellPct, slippageBps, maxImpactPct, prioFee, commitment]);

  // settings export/import
  function exportSettings(){
    const data = { endpoint, autoScan, scanSec, recentOnlyMins, minLiq, minVol, maxFdv, minH1, maxH1, slippageBps, buySol, sellPct, maxImpactPct, prioFee, commitment, wl, bl, ladders };
    const blob = new Blob([JSON.stringify(data,null,2)], {type:"application/json"});
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "creator-snipe-settings.json";
    a.click();
    URL.revokeObjectURL(url);
  }
  function importSettings(ev: React.ChangeEvent<HTMLInputElement>){
    const f = ev.target.files?.[0]; if (!f) return;
    const reader = new FileReader();
    reader.onload = ()=>{
      try{
        const j:any = JSON.parse(String(reader.result||"{}"));
        setEndpoint(j.endpoint||endpoint);
        setAutoScan(!!j.autoScan); setScanSec(j.scanSec||scanSec);
        setRecentOnlyMins(j.recentOnlyMins||recentOnlyMins);
        setMinLiq(j.minLiq||minLiq); setMinVol(j.minVol||minVol); setMaxFdv(j.maxFdv||maxFdv);
        setMinH1(j.minH1||minH1); setMaxH1(j.maxH1||maxH1);
        setSlippageBps(j.slippageBps||slippageBps); setBuySol(j.buySol||buySol); setSellPct(j.sellPct||sellPct);
        setMaxImpactPct(j.maxImpactPct||maxImpactPct); setPrioFee(j.prioFee||prioFee); setCommitment(j.commitment||commitment);
        setWl(j.wl||wl); setBl(j.bl||bl); setLadders(j.ladders||ladders);
        setStatus("Настройки импортированы");
      }catch(e:any){ setStatus("Импорт не удался: "+(e?.message||String(e))); }
    };
    reader.readAsText(f);
  }

  function armLadder(mint: string, pair: DexPair){
    const curr = ladders[mint] || { levels:[2,3,5,10], parts:[40,20,20,20], armed: false };
    const next = { ...ladders };
    next[mint] = { ...curr, armed: true, entryUsd: Number(pair.priceUsd||"0")||undefined, pairAddress: pair.pairAddress, chainId: pair.chainId, executed: curr.levels.map(()=>false) };
    setLadders(next);
  }
  function disarmLadder(mint:string){
    const next = { ...ladders };
    if (next[mint]) next[mint].armed = false;
    setLadders(next);
  }
  function updateLadder(mint:string, levels:string, parts:string){
    const lvl = levels.split(",").map(s=> Number(s.trim())||0).filter(x=>x>0);
    const prt = parts.split(",").map(s=> Number(s.trim())||0).filter(x=>x>=0);
    if (lvl.length===0 || lvl.length!==prt.length) { setStatus("Проверь лесенку: длины совпадают, уровни > 0"); return; }
    if (prt.reduce((a,b)=>a+b,0) > 100) { setStatus("Сумма долей должна быть ≤ 100"); return; }
    const next = { ...ladders };
    next[mint] = { levels:lvl, parts:prt, armed: next[mint]?.armed||false, entryUsd: next[mint]?.entryUsd, pairAddress: next[mint]?.pairAddress, chainId: next[mint]?.chainId, executed: lvl.map(()=>false) };
    setLadders(next);
  }

  function pctFmt(n:number){ return `${n.toFixed(1)}%`; }
  function dexLink(chainId?: string, pairAddress?: string){ return (!chainId||!pairAddress) ? "https://dexscreener.com" : `https://dexscreener.com/${encodeURIComponent(chainId)}/${encodeURIComponent(pairAddress)}`; }

  return (
    <div className="min-h-screen bg-[#0A0B0F] text-white">
      <section className="max-w-6xl mx-auto px-5 pt-6 pb-2">
        <div className="flex items-center justify-between gap-3">
          <div className="inline-flex items-center gap-2">
            <Rocket className="w-5 h-5 text-cyan-300"/><span className={`${pill}`}>Creator-Snipe Ultimate</span>
          </div>
          <div className="flex items-center gap-2">
            <input className="bg-white/5 border border-white/10 rounded-xl px-2 py-1 text-xs w-80" placeholder="Custom RPC" value={endpoint} onChange={(e)=>setEndpoint(e.target.value)} />
            <div className="flex items-center gap-1 text-xs">
              <button onClick={exportSettings} className={`${pill} flex items-center gap-1`}><Download className="w-4 h-4"/>Export</button>
              <label className={`${pill} flex items-center gap-1 cursor-pointer`}>
                <Upload className="w-4 h-4"/>Import
                <input type="file" accept="application/json" className="hidden" onChange={importSettings}/>
              </label>
            </div>
            <WalletMultiButton className="!bg-white !text-black !rounded-xl !px-3 !py-1 text-sm"/>
          </div>
        </div>
      </section>

      <section className="max-w-3xl mx-auto px-5 pt-2 pb-2 text-center">
        <div className="inline-flex gap-3">
          <button onClick={()=>setRun(v=>!v)} className="px-4 py-2 rounded-xl bg-white/10 border border-white/10 hover:bg-white/15">
            {run? <span className="inline-flex items-center gap-2"><Play className="w-4 h-4 text-emerald-400"/> Live</span> : <span className="inline-flex items-center gap-2"><Pause className="w-4 h-4 text-yellow-300"/> Paused</span>}
          </button>
        </div>
        {status && <div className="mt-3 text-xs opacity-80">{status}</div>}
      </section>

      {/* Sparkline */}
      <section className="max-w-3xl mx-auto px-5">
        <div className={`${glass} rounded-2xl p-3 h-32`}>
          <div className="text-xs opacity-70 mb-1">Live (visual)</div>
          <div className="h-24">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={live}><Line type="monotone" dataKey="p" dot={false} strokeWidth={2} /></LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </section>

      {/* Controls */}
      <section className="max-w-6xl mx-auto px-5 mt-6 grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className={`${glass} rounded-2xl p-4`}>
          <h3 className="font-semibold mb-2">Торговля</h3>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <Labeled label="Slippage (bps)"><input type="number" className="w-full bg-white/5 border border-white/10 rounded-xl px-2 py-1" value={String(slippageBps)} onChange={(e)=>setSlippageBps(Number(e.target.value)||0)}/></Labeled>
            <Labeled label="Max price impact %"><input type="number" className="w-full bg-white/5 border border-white/10 rounded-xl px-2 py-1" value={String(maxImpactPct)} onChange={(e)=>setMaxImpactPct(Number(e.target.value)||0)}/></Labeled>
            <Labeled label="Buy SOL amount"><input type="number" className="w-full bg-white/5 border border-white/10 rounded-xl px-2 py-1" value={String(buySol)} onChange={(e)=>setBuySol(Number(e.target.value)||0)}/></Labeled>
            <Labeled label="Sell default %"><input type="number" className="w-full bg-white/5 border border-white/10 rounded-xl px-2 py-1" value={String(sellPct)} onChange={(e)=>setSellPct(Number(e.target.value)||0)}/></Labeled>
            <Labeled label="Priority fee (lamports)"><input type="number" className="w-full bg-white/5 border border-white/10 rounded-xl px-2 py-1" value={String(prioFee)} onChange={(e)=>setPrioFee(Number(e.target.value)||0)}/></Labeled>
            <Labeled label="Confirm level">
              <select className="w-full bg-white/5 border border-white/10 rounded-xl px-2 py-1" value={commitment} onChange={(e)=>setCommitment(e.target.value as any)}>
                <option value="processed">processed</option>
                <option value="confirmed">confirmed</option>
                <option value="finalized">finalized</option>
              </select>
            </Labeled>
            <Labeled label="Pre-trade simulation"><input type="checkbox" checked={preSim} onChange={(e)=>setPreSim(e.target.checked)}/></Labeled>
          </div>
          <div className="text-[11px] opacity-70 mt-2 flex items-center gap-2"><Wallet className="w-4 h-4"/> Подключите кошелек, затем Buy/Sell у нужной пары.</div>
        </div>

        <div className={`${glass} rounded-2xl p-4`}>
          <h3 className="font-semibold mb-2">Фильтры</h3>
          <div className="grid grid-cols-2 gap-2 text-[11px]">
            <Num label="new ≤ (min)" v={recentOnlyMins} set={setRecentOnlyMins}/>
            <Num label="Min Liq $" v={minLiq} set={setMinLiq}/>
            <Num label="Min Vol24h $" v={minVol} set={setMinVol}/>
            <Num label="Max FDV $" v={maxFdv} set={setMaxFdv}/>
            <Num label="Min 1h %" v={minH1} set={setMinH1}/>
            <Num label="Max 1h %" v={maxH1} set={setMaxH1}/>
            <Num label="Scan sec" v={scanSec} set={setScanSec}/>
          </div>
          <div className="text-[11px] opacity-70 mt-2 flex flex-wrap gap-2">
            <span className={pill}>Auto-Scan: {autoScan? "ON":"OFF"}</span>
            {lastScanAt && <span className={pill}>Last: {new Date(lastScanAt).toLocaleTimeString()}</span>}
            <button onClick={()=>setAutoScan(v=>!v)} className={`${pill} hover:border-cyan-400/50`}>{autoScan? "Отключить":"Включить"}</button>
          </div>
        </div>

        <div className={`${glass} rounded-2xl p-4`}>
          <h3 className="font-semibold mb-2">Списки</h3>
          <ListEditor label="Whitelist mint" list={wl} setList={setWl}/>
          <div className="h-2"></div>
          <ListEditor label="Blacklist mint" list={bl} setList={setBl}/>
        </div>
      </section>

      {/* Feed */}
      <section className="max-w-6xl mx-auto px-5 mt-6">
        <div className="grid gap-2">
          {autoRows.map((r,i)=>{
            const mint = r.baseToken?.address || "";
            const sym = r.baseToken?.symbol || "???";
            const L = ladders[mint] || { levels:[2,3,5,10], parts:[40,20,20,20], armed:false };
            return (
              <div key={(r.pairAddress||'')+i} className="bg-white/5 border border-white/10 rounded-xl px-3 py-2">
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{sym}/{r.quoteToken?.symbol}</span>
                    <a className="text-xs opacity-70 underline" href={dexLink(r.chainId, r.pairAddress)} target="_blank" rel="noreferrer">dex</a>
                    <MintGuards mint={mint} conn={conn}/>
                  </div>
                  <div className="flex items-center gap-2">
                    {mint && <button onClick={()=>buyBase(mint, r)} className="px-3 py-1 rounded-lg bg-emerald-400 text-black text-xs inline-flex items-center gap-1"><DollarSign className="w-4 h-4"/>Buy</button>}
                    {mint && <SellRow onSell={(p)=>sellBasePct(mint,p)} defaultPct={sellPct}/>}
                  </div>
                </div>

                {/* ladder */}
                <div className="mt-2 text-[11px]">
                  <div className="flex items-center justify-between">
                    <div className="flex gap-2 items-center">
                      <span className="opacity-70">TP Ladder:</span>
                      <span className={pill}>× {L.levels.join(", ")}</span>
                      <span className={pill}>% {L.parts.join(", ")}</span>
                      <span className={pill}>{L.armed? "ARMED":"disarmed"}</span>
                    </div>
                    <div className="flex gap-2">
                      <button onClick={()=>updateLadder(mint, prompt("Levels (comma)","2,3,5,10")||"", prompt("Parts (comma)","40,20,20,20")||"")} className={`${pill}`}>Edit</button>
                      {!L.armed && <button onClick={()=>armLadder(mint, r)} className={`${pill}`}>Arm</button>}
                      {L.armed && <button onClick={()=>disarmLadder(mint)} className={`${pill}`}>Disarm</button>}
                    </div>
                  </div>
                </div>

                {/* stats */}
                <div className="text-[11px] opacity-80 flex flex-wrap gap-3 mt-2">
                  {r.priceUsd && <span className={pill}>${Number(r.priceUsd).toFixed(6)}</span>}
                  {typeof r.fdv==='number' && <span className={pill}>FDV ${Math.round(r.fdv).toLocaleString()}</span>}
                  {typeof r.liquidity?.usd==='number' && <span className={pill}>Liq ${Math.round(r.liquidity.usd).toLocaleString()}</span>}
                  {typeof r.volume?.h24==='number' && <span className={pill}>Vol24h ${Math.round(r.volume.h24).toLocaleString()}</span>}
                  {typeof r.priceChange?.m5==='number' && <span className={pill}>5m {pctFmt(r.priceChange.m5)}</span>}
                  {typeof r.priceChange?.h1==='number' && <span className={pill}>1h {pctFmt(r.priceChange.h1)}</span>}
                  {r.pairCreatedAt && <span className={pill}>new {Math.max(0, Math.floor((Date.now() - r.pairCreatedAt)/60000))}m</span>}
                </div>
              </div>
            )
          })}
          {autoRows.length===0 && <div className="text-xs opacity-70">Нет совпадений под фильтры. Отрегулируйте условия или подождите новый скан.</div>}
        </div>
      </section>

      <footer className="max-w-6xl mx-auto px-5 py-10 text-xs opacity-60">Not financial advice. Реальная торговля — на ваш риск.</footer>
    </div>
  );
}

function Labeled({label, children}:{label:string; children:React.ReactNode}){
  return <label className="text-xs w-full"><div className="mb-1 opacity-70">{label}</div>{children}</label>;
}
function Num({label, v, set}:{label:string; v:number; set:(n:number)=>void}){
  return <label className="text-[11px] w-full"><div className="mb-1 opacity-70">{label}</div><input type="number" value={String(v)} onChange={(e)=>set(Number(e.target.value)||0)} className="w-full bg-white/5 border border-white/10 rounded-xl px-2 py-1 outline-none"/></label>;
}

function ListEditor({label, list, setList}:{label:string; list:string[]; setList:(l:string[])=>void}){
  const [v, setV] = useState("");
  return (
    <div className="text-xs">
      <div className="mb-1 opacity-70">{label}</div>
      <div className="flex gap-2">
        <input value={v} onChange={(e)=>setV(e.target.value)} placeholder="Mint address" className="flex-1 bg-white/5 border border-white/10 rounded-xl px-3 py-2 outline-none"/>
        <button onClick={()=>{ const a=v.trim(); if(!a) return; if(!list.find(x=>x.toLowerCase()===a.toLowerCase())) setList([a, ...list].slice(0,100)); setV(""); }} className="px-3 rounded-xl bg-white/10 border border-white/10 hover:bg-white/20">Добавить</button>
      </div>
      <div className="mt-2 grid gap-2">
        {list.map(a=> (
          <div key={a} className="flex items-center justify-between bg-white/5 border border-white/10 rounded-xl px-3 py-2">
            <span className="font-mono">{a.slice(0,4)}…{a.slice(-4)}</span>
            <button onClick={()=> setList(list.filter(x=>x!==a))} className="text-white/70 hover:text-white">Удалить</button>
          </div>
        ))}
        {list.length===0 && <div className="text-[11px] opacity-70">Список пуст</div>}
      </div>
    </div>
  );
}

function SellRow({onSell, defaultPct}:{onSell:(pct:number)=>void; defaultPct:number}){
  return (
    <div className="flex items-center gap-1">
      <button onClick={()=>onSell(25)} className="px-2 py-1 rounded bg-white/10 border border-white/10 text-[11px]">25%</button>
      <button onClick={()=>onSell(50)} className="px-2 py-1 rounded bg-white/10 border border-white/10 text-[11px]">50%</button>
      <button onClick={()=>onSell(75)} className="px-2 py-1 rounded bg-white/10 border border-white/10 text-[11px]">75%</button>
      <button onClick={()=>onSell(100)} className="px-2 py-1 rounded bg-white/10 border border-white/10 text-[11px]">100%</button>
      <button onClick={()=>onSell(defaultPct)} className="px-3 py-1 rounded bg-white/5 border border-white/10 text-[11px]">Sell {defaultPct}%</button>
    </div>
  );
}

function MintGuards({mint, conn}:{mint:string; conn:Connection}){
  const [ok, setOk] = useState<null|boolean>(null);
  useEffect(()=>{
    let mounted = true;
    (async()=>{
      try{
        const { mintAuthorityNull, freezeAuthorityNull } = await getMintRisk(conn, mint);
        if (mounted) setOk(!!(mintAuthorityNull && freezeAuthorityNull));
      }catch{ if (mounted) setOk(false); }
    })();
    return ()=>{ mounted=false };
  },[mint, conn]);
  if (ok===null) return <span className={`${pill}`}>mint?</span>;
  return ok? <span className={`${pill} inline-flex items-center gap-1`}><ShieldCheck className="w-4 h-4"/>mint/freeze null</span> : <span className={`${pill} inline-flex items-center gap-1`}><ShieldAlert className="w-4 h-4"/>authority set</span>;
}
