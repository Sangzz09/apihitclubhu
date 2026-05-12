const https = require("https");
const http  = require("http");

const SOURCE_URL  = "https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=g8&gid=vgmn_100";
const PORT        = process.env.PORT || 3000;
const HISTORY_MAX = 500;
const BOT_ID      = "@sewdangcap";

let history        = [];
let lastSid        = null;
let pendingSession = null;
let lastDice       = null;

// ══════════════════════════════════════════════════════════════
// FETCH
// ══════════════════════════════════════════════════════════════
function fetchSource() {
  return new Promise((resolve, reject) => {
    const req = https.get(SOURCE_URL, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }
    }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try { resolve({ ok: true, body: JSON.parse(raw) }); }
        catch { resolve({ ok: false, raw: raw.slice(0, 800) }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(14000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ══════════════════════════════════════════════════════════════
// PARSE
// ══════════════════════════════════════════════════════════════
function parseBody(body) {
  if (!body || body.status !== "OK") return null;
  const entry = Array.isArray(body.data) ? body.data[0] : null;
  if (!entry) return null;
  const cmd = Number(entry.cmd);

  if (cmd === 1008) {
    const sid  = String(entry.sid ?? "?");
    const gi0  = Array.isArray(entry.gi) ? entry.gi[0] : null;
    if (!gi0) return null;
    const sTB  = Number(gi0.B?.tB ?? 0);
    const sTU  = Number(gi0.B?.tU ?? 0);
    const bTB  = Number(gi0.S?.tB ?? 0);
    const bTU  = Number(gi0.S?.tU ?? 0);
    const total = sTB + bTB;
    const ratio = total > 0 ? sTB / total : 0.5;
    return { kind: "betting", sid, sTB, sTU, bTB, bTU, total, ratio };
  }

  if (cmd === 1003) {
    const d1 = entry.d1 ?? null, d2 = entry.d2 ?? null, d3 = entry.d3 ?? null;
    if (d1 === null || d2 === null || d3 === null) return null;
    const dice = { d1: Number(d1), d2: Number(d2), d3: Number(d3), sum: Number(d1)+Number(d2)+Number(d3) };
    return { kind: "result", dice };
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// KẾT QUẢ SUY LUẬN
// ══════════════════════════════════════════════════════════════
function inferType(ratio, prevType, dice) {
  if (dice && dice.sum != null) return dice.sum >= 11 ? "T" : "X";
  if (ratio > 0.58) return "T";
  if (ratio < 0.42) return "X";
  return prevType ?? (ratio >= 0.5 ? "T" : "X");
}

// ══════════════════════════════════════════════════════════════
// INGEST
// ══════════════════════════════════════════════════════════════
function ingest(parsed) {
  if (!parsed) return false;

  if (parsed.kind === "betting") {
    const { sid, sTB, sTU, bTB, bTU, total, ratio } = parsed;
    if (sid === lastSid) {
      if (pendingSession) Object.assign(pendingSession, { sTB, sTU, bTB, bTU, total, ratio });
      return false;
    }
    if (pendingSession) {
      if (!pendingSession.dice && lastDice) pendingSession.dice = lastDice;
      const prevType = history[0]?.type ?? null;
      pendingSession.type = inferType(pendingSession.ratio, prevType, pendingSession.dice);
      history.unshift(pendingSession);
      if (history.length > HISTORY_MAX) history = history.slice(0, HISTORY_MAX);
      if (history.length >= 2) recordActual(history[0].type);
      lastDice = null;
    }
    pendingSession = { phien: sid, sTB, sTU, bTB, bTU, total, ratio, dice: null };
    lastSid = sid;
    return true;
  }

  if (parsed.kind === "result") {
    lastDice = parsed.dice;
    if (pendingSession) pendingSession.dice = parsed.dice;
    return false;
  }
  return false;
}

// ══════════════════════════════════════════════════════════════
// TRỌNG LƯỢNG TỰ HIỆU CHỈNH
// ══════════════════════════════════════════════════════════════
const ALGOS = [
  "pattern","markov10","markov9","markov8","markov7","markov6",
  "markov5","markov4","markov3","markov2","markov1",
  "freq","luong","streak5","entropy",
  "chuky","autocorr","momentum","bayesian",
  "ngram4","reversal","chiSq","trendFollow",
  "streakLen","ratio","ratioMa","contrarian",
  "cau11","cau22","cau33","cauZigZag","cauBreak",
  "cauGap","cauBlock","cauMirror","cauAccel",
  "parity","sumTrend","highLow","altBlock"
];
const acc = {};
for (const n of ALGOS) acc[n] = { c: 20, t: 40 };

function updateAcc(name, pred, actual) {
  if (!acc[name]) return;
  acc[name].t++;
  if (pred === actual) acc[name].c++;
  if (acc[name].t > 80) { acc[name].c *= 80 / acc[name].t; acc[name].t = 80; }
}
function getWeight(name) {
  const a = acc[name];
  if (!a || a.t < 8) return 1.0;
  const r = a.c / a.t;
  return Math.max(0, (r - 0.38) / 0.12);
}

let lastPreds = {};
function recordActual(actual) {
  for (const [name, pred] of Object.entries(lastPreds)) updateAcc(name, pred, actual);
  lastPreds = {};
}

// ══════════════════════════════════════════════════════════════
// PHÁT HIỆN CẦU (mở rộng)
// ══════════════════════════════════════════════════════════════
function detectPattern(seq) {
  if (seq.length < 4) return null;
  const s = seq.join("");

  // ── Bệt dài ──────────────────────────────────────────────
  const bm = s.match(/^(T{3,}|X{3,})/);
  if (bm) {
    const len  = bm[0].length;
    const same = bm[0][0];
    const next = len >= 7 ? (same === "T" ? "X" : "T") : same;
    const conf = len >= 7 ? 0.70 : Math.min(0.54 + len * 0.03, 0.80);
    return { name: `Bệt ${same === "T" ? "Tài" : "Xỉu"}(${len})`, next, conf };
  }

  // ── Cầu 1-1 ──────────────────────────────────────────────
  let alt = 0;
  for (let i = 0; i < Math.min(seq.length, 14); i++) {
    if (i === 0 || seq[i] !== seq[i-1]) alt++;
    else break;
  }
  if (alt >= 8) return { name: "Cầu 1-1 siêu dài", next: seq[0] === "T" ? "X" : "T", conf: 0.78 };
  if (alt >= 6) return { name: "Cầu 1-1 dài",      next: seq[0] === "T" ? "X" : "T", conf: 0.73 };
  if (alt >= 4) return { name: "Cầu 1-1",           next: seq[0] === "T" ? "X" : "T", conf: 0.64 };

  // ── Cầu 2-2 ──────────────────────────────────────────────
  if (s.length >= 8 && s[0]===s[1] && s[2]===s[3] && s[0]!==s[2] && s[4]===s[5] && s[0]===s[4])
    return { name: "Cầu 2-2", next: s[0], conf: 0.68 };
  if (s.length >= 6 && s[0]!==s[1] && s[1]===s[2] && s[3]===s[4] && s[1]!==s[3])
    return { name: "Cầu 2-2 giữa", next: s[0]==="T"?"X":"T", conf: 0.63 };

  // ── Cầu 3-3 ──────────────────────────────────────────────
  if (s.length >= 6 && s[0]===s[1] && s[1]===s[2] && s[3]===s[4] && s[4]===s[5] && s[0]!==s[3])
    return { name: "Cầu 3-3", next: s[0], conf: 0.65 };

  // ── Cầu 4-4 ──────────────────────────────────────────────
  if (s.length >= 8 && s.slice(0,4).split("").every(c=>c===s[0]) &&
      s.slice(4,8).split("").every(c=>c===s[4]) && s[0]!==s[4])
    return { name: "Cầu 4-4", next: s[0], conf: 0.66 };

  // ── Cầu 5-5 ──────────────────────────────────────────────
  if (s.length >= 10 && s.slice(0,5).split("").every(c=>c===s[0]) &&
      s.slice(5,10).split("").every(c=>c===s[5]) && s[0]!==s[5])
    return { name: "Cầu 5-5", next: s[0], conf: 0.67 };

  // ── Cầu 2-1 / 1-2 ────────────────────────────────────────
  if (s.length >= 6 && s[0]===s[1] && s[2]!==s[1] && s[3]===s[4] && s[5]!==s[4] && s[0]===s[3])
    return { name: "Cầu 2-1", next: s[0], conf: 0.62 };
  if (s.length >= 6 && s[0]!==s[1] && s[1]===s[2] && s[3]!==s[4] && s[4]===s[5])
    return { name: "Cầu 1-2", next: s[0], conf: 0.61 };

  // ── Cầu 3-1 / 1-3 ────────────────────────────────────────
  if (s.length >= 8 && s[0]===s[1] && s[1]===s[2] && s[3]!==s[0] && s[4]===s[5] && s[5]===s[6] && s[4]!==s[3])
    return { name: "Cầu 3-1 lặp", next: s[0], conf: 0.64 };
  if (s.length >= 8 && s[0]!==s[1] && s[1]===s[2] && s[2]===s[3] && s[4]!==s[0])
    return { name: "Cầu 1-3", next: s[0], conf: 0.62 };

  // ── Cầu Zigzag kép: TTXX hoặc XXTT ──────────────────────
  if (s.length >= 8 && s.slice(0,2).split("").every(c=>c==="T") &&
      s.slice(2,4).split("").every(c=>c==="X") &&
      s.slice(4,6).split("").every(c=>c==="T") &&
      s.slice(6,8).split("").every(c=>c==="X"))
    return { name: "Zigzag TTXX", next: "T", conf: 0.66 };
  if (s.length >= 8 && s.slice(0,2).split("").every(c=>c==="X") &&
      s.slice(2,4).split("").every(c=>c==="T") &&
      s.slice(4,6).split("").every(c=>c==="X") &&
      s.slice(6,8).split("").every(c=>c==="T"))
    return { name: "Zigzag XXTT", next: "X", conf: 0.66 };

  // ── Cầu gương / đối xứng ─────────────────────────────────
  if (s.length >= 5 && s[0]===s[4] && s[1]===s[3] && s[1]!==s[0])
    return { name: "Cầu Gương 5", next: s[1]==="T"?"X":"T", conf: 0.60 };
  if (s.length >= 6 && s[0]===s[5] && s[1]===s[4] && s[2]===s[3])
    return { name: "Cầu Gương 6", next: s[0]==="T"?"X":"T", conf: 0.61 };

  // ── Chu kỳ p = 2..6 ──────────────────────────────────────
  for (const p of [2,3,4,5,6]) {
    if (s.length >= p*3) {
      const c = s.slice(0,p);
      if (s.slice(p,p*2)===c && s.slice(p*2,p*3)===c)
        return { name: `Chu Kỳ ${p}`, next: c[0], conf: 0.65+p*0.01 };
    }
  }

  // ── Cầu tăng dần T (T xuất hiện ngày càng nhiều) ─────────
  if (s.length >= 9) {
    const w1 = s.slice(0,3).split("").filter(c=>c==="T").length;
    const w2 = s.slice(3,6).split("").filter(c=>c==="T").length;
    const w3 = s.slice(6,9).split("").filter(c=>c==="T").length;
    if (w1 > w2 && w2 > w3) return { name: "Cầu T giảm", next: "X", conf: 0.60 };
    if (w1 < w2 && w2 < w3) return { name: "Cầu T tăng", next: "T", conf: 0.60 };
  }

  // ── Cầu Block ngắt: 3T + 1X + 3T ─────────────────────────
  if (s.length >= 7 && s.slice(0,3)==="TTT" && s[3]==="X" && s.slice(4,7)==="TTT")
    return { name: "Block T-break-T", next: "T", conf: 0.64 };
  if (s.length >= 7 && s.slice(0,3)==="XXX" && s[3]==="T" && s.slice(4,7)==="XXX")
    return { name: "Block X-break-X", next: "X", conf: 0.64 };

  // ── Cầu N+1 bệt (tăng độ dài): T, TT, TTT... ─────────────
  if (s.length >= 6) {
    if (s[0]==="T" && s.slice(1,3)==="TT" && s.slice(3,6)==="TTT")
      return { name: "Cầu Leo thang T", next: "T", conf: 0.63 };
    if (s[0]==="X" && s.slice(1,3)==="XX" && s.slice(3,6)==="XXX")
      return { name: "Cầu Leo thang X", next: "X", conf: 0.63 };
  }

  return null;
}

// ══════════════════════════════════════════════════════════════
// MARKOV bậc N (tổng quát)
// ══════════════════════════════════════════════════════════════
function algoMarkovN(seq, n, minSamples) {
  if (seq.length < n + minSamples) return null;
  const t = {};
  for (let i = 0; i < seq.length - n; i++) {
    // key = seq[i+n-1]...seq[i+1] (trạng thái hiện tại, mới nhất trước)
    const k = seq.slice(i+1, i+n+1).reverse().join("");
    if (!t[k]) t[k] = { T: 0, X: 0 };
    t[k][seq[i]]++;
  }
  const k = seq.slice(0, n).join("");
  const row = t[k];
  if (!row) return null;
  const tot = row.T + row.X;
  if (tot < minSamples) return null;
  if (row.T > row.X) return { next: "T", conf: 0.50 + (row.T/tot - 0.50) * Math.min(0.60 + n*0.02, 0.80) };
  if (row.X > row.T) return { next: "X", conf: 0.50 + (row.X/tot - 0.50) * Math.min(0.60 + n*0.02, 0.80) };
  return null;
}

// ══════════════════════════════════════════════════════════════
// CÁC THUẬT TOÁN CŨ (giữ nguyên)
// ══════════════════════════════════════════════════════════════
function algoFreq(seq) {
  const n20=Math.min(seq.length,20), n50=Math.min(seq.length,50);
  const rT=seq.slice(0,n20).filter(x=>x==="T").length/n20*0.6
           +seq.slice(0,n50).filter(x=>x==="T").length/n50*0.4;
  const rX=1-rT;
  if (rT>0.60) return { next:"X", conf:0.50+(rT-0.50)*0.60 };
  if (rX>0.60) return { next:"T", conf:0.50+(rX-0.50)*0.60 };
  return null;
}
function algoLuong(seq) {
  if (seq.length<8) return null;
  const w=seq.slice(0,8); let tr=0;
  for (let i=1;i<w.length;i++) if (w[i]!==w[i-1]) tr++;
  if (tr<=1) return { next:w[0], conf:0.64 };
  if (tr>=7) return { next:w[0]==="T"?"X":"T", conf:0.64 };
  return null;
}
function algoStreak5(seq) {
  if (seq.length<5) return null;
  const f=seq[0];
  if (seq.slice(0,5).every(x=>x===f)) return { next:f==="T"?"X":"T", conf:0.67 };
  return null;
}
function algoEntropy(seq) {
  const n=Math.min(seq.length,20); const sub=seq.slice(0,n);
  let tr=0; for (let i=1;i<sub.length;i++) if (sub[i]!==sub[i-1]) tr++;
  const e=tr/(n-1);
  if (e>0.38&&e<0.62) return null;
  if (e<=0.38) return { next:sub[0], conf:0.61 };
  return { next:sub[0]==="T"?"X":"T", conf:0.59 };
}
function algoChuKy(seq) {
  if (seq.length<12) return null;
  for (let p=2;p<=6;p++) {
    let match=0, total=0;
    for (let i=0;i<Math.min(seq.length-p,20);i++) {
      if (seq[i+p]!==undefined) { total++; if (seq[i]===seq[i+p]) match++; }
    }
    if (total>=6 && match/total>=0.75)
      return { next:seq[p-1]??seq[0], conf:0.56+(match/total-0.75)*0.5 };
  }
  return null;
}
function algoAutoCorr(seq) {
  if (seq.length<20) return null;
  const n=Math.min(seq.length,40);
  const v=seq.slice(0,n).map(x=>x==="T"?1:0);
  const mean=v.reduce((a,b)=>a+b,0)/n;
  let ac1=0, denom=0;
  for (let i=0;i<n;i++) denom+=(v[i]-mean)**2;
  for (let i=1;i<n;i++) ac1+=(v[i]-mean)*(v[i-1]-mean);
  ac1/=denom;
  if (ac1>0.15)  return { next:seq[0],               conf:0.54+Math.min(ac1*0.4,0.10) };
  if (ac1<-0.15) return { next:seq[0]==="T"?"X":"T", conf:0.54+Math.min(-ac1*0.4,0.10) };
  return null;
}
function algoMomentum(seq) {
  if (seq.length<30) return null;
  const s=seq.slice(0,5).filter(x=>x==="T").length/5;
  const l=seq.slice(0,20).filter(x=>x==="T").length/20;
  const d=s-l;
  if (d>0.25)  return { next:"T", conf:0.55+Math.min(d*0.3,0.08) };
  if (d<-0.25) return { next:"X", conf:0.55+Math.min(-d*0.3,0.08) };
  return null;
}
function algoBayesian(seq) {
  if (seq.length<15) return null;
  let logOdds=0;
  for (const w of [3,5,8,13]) {
    const sub=seq.slice(0,Math.min(w,seq.length));
    const pT=(sub.filter(x=>x==="T").length+1)/(sub.length+2);
    logOdds+=Math.log(pT/(1-pT))/4;
  }
  const pT=1/(1+Math.exp(-logOdds));
  if (pT>0.58) return { next:"T", conf:0.50+(pT-0.50)*0.8 };
  if (pT<0.42) return { next:"X", conf:0.50+(0.50-pT)*0.8 };
  return null;
}
function algoNgram4(seq) {
  if (seq.length<25) return null;
  const t={};
  for (let i=0;i<seq.length-4;i++) {
    const k=seq[i+4]+seq[i+3]+seq[i+2]+seq[i+1];
    if (!t[k]) t[k]={T:0,X:0};
    t[k][seq[i]]++;
  }
  const k=seq[3]+seq[2]+seq[1]+seq[0]; const row=t[k]; if (!row) return null;
  const tot=row.T+row.X; if (tot<4) return null;
  if (row.T>row.X) return { next:"T", conf:0.50+(row.T/tot-0.50)*0.72 };
  if (row.X>row.T) return { next:"X", conf:0.50+(row.X/tot-0.50)*0.72 };
  return null;
}
function algoReversal(seq) {
  if (seq.length<20) return null;
  let sLen=1; while (sLen<seq.length && seq[sLen]===seq[0]) sLen++;
  if (sLen<2) return null;
  let rev=0, samp=0;
  for (let i=sLen;i<seq.length-sLen;i++) {
    if (seq.slice(i,i+sLen).every(x=>x===seq[i])) {
      samp++; if (seq[i-1]!==seq[i]) rev++; i+=sLen-1;
    }
  }
  if (samp<3) return null;
  const pr=rev/samp;
  if (pr>0.65) return { next:seq[0]==="T"?"X":"T", conf:0.52+pr*0.10 };
  if (pr<0.35) return { next:seq[0],               conf:0.52+(1-pr)*0.10 };
  return null;
}
function algoChiSq(seq) {
  if (seq.length<30) return null;
  const obs={TT:0,TX:0,XT:0,XX:0};
  for (let i=0;i<seq.length-1;i++) { const k=seq[i+1]+seq[i]; if (obs[k]!==undefined) obs[k]++; }
  const n=Object.values(obs).reduce((a,b)=>a+b,0);
  const exp=n/4;
  const chi2=Object.values(obs).reduce((s,o)=>s+(o-exp)**2/exp,0);
  if (chi2<3.84) return null;
  const pTT=obs.TT/(obs.TT+obs.TX+0.001);
  const pXX=obs.XX/(obs.XX+obs.XT+0.001);
  if (seq[0]==="T"&&pTT>0.60) return { next:"T", conf:0.52+pTT*0.10 };
  if (seq[0]==="T"&&pTT<0.40) return { next:"X", conf:0.52+(1-pTT)*0.10 };
  if (seq[0]==="X"&&pXX>0.60) return { next:"X", conf:0.52+pXX*0.10 };
  if (seq[0]==="X"&&pXX<0.40) return { next:"T", conf:0.52+(1-pXX)*0.10 };
  return null;
}
function algoTrendFollow(seq) {
  if (seq.length<12) return null;
  const v=seq.slice(0,20).map(x=>x==="T"?1:0);
  const ema=(arr,a)=>arr.reduce((e,x,i)=>i===0?x:a*x+(1-a)*e,arr[0]);
  const e5=ema(v.slice(0,5),0.4), e12=ema(v.slice(0,12),0.2);
  if (e5>e12+0.08) return { next:"T", conf:0.55 };
  if (e5<e12-0.08) return { next:"X", conf:0.55 };
  return null;
}
function algoStreakLen(seq) {
  if (seq.length<20) return null;
  const streaks=[]; let cur=1;
  for (let i=1;i<seq.length;i++) {
    if (seq[i]===seq[i-1]) cur++;
    else { streaks.push(cur); cur=1; }
  }
  streaks.push(cur);
  if (streaks.length<4) return null;
  const avgLen=streaks.reduce((a,b)=>a+b,0)/streaks.length;
  let curLen=1; while (curLen<seq.length && seq[curLen]===seq[0]) curLen++;
  if (curLen>=Math.ceil(avgLen*1.5)) return { next:seq[0]==="T"?"X":"T", conf:0.57 };
  if (curLen===1 && curLen<avgLen*0.6) return { next:seq[0], conf:0.54 };
  return null;
}
function algoRatio(hist) {
  if (!hist.length) return null;
  const r=hist[0].ratio;
  if (r>0.62) return { next:"T", conf:0.50+(r-0.50)*0.55 };
  if (r<0.38) return { next:"X", conf:0.50+(0.50-r)*0.55 };
  return null;
}
function algoRatioMa(hist) {
  if (hist.length<5) return null;
  const ma=hist.slice(0,5).reduce((s,h)=>s+h.ratio,0)/5;
  if (ma>0.60) return { next:"T", conf:0.52+(ma-0.50)*0.40 };
  if (ma<0.40) return { next:"X", conf:0.52+(0.50-ma)*0.40 };
  return null;
}
function algoContrarian(hist) {
  if (hist.length<10) return null;
  const avgTotal=hist.slice(1,11).reduce((s,h)=>s+(h.total||0),0)/10;
  const cur=hist[0];
  if ((cur.total||0)<avgTotal*0.5) return null;
  const r=cur.ratio;
  if (r>0.65) return { next:"T", conf:0.58+(r-0.65)*0.40 };
  if (r<0.35) return { next:"X", conf:0.58+(0.35-r)*0.40 };
  return null;
}

// ── Cầu 1-1 chuyên biệt ──────────────────────────────────────
function algoCau11(seq) {
  if (seq.length < 6) return null;
  let alt = 0;
  for (let i = 1; i < seq.length; i++) { if (seq[i] !== seq[i-1]) alt++; else break; }
  if (alt >= 5) return { next: seq[0] === "T" ? "X" : "T", conf: 0.67 };
  return null;
}

// ── Cầu 2-2 chuyên biệt ──────────────────────────────────────
function algoCau22(seq) {
  if (seq.length < 8) return null;
  if (seq[0]===seq[1] && seq[2]===seq[3] && seq[0]!==seq[2] &&
      seq[4]===seq[5] && seq[6]===seq[7] && seq[4]!==seq[6] &&
      seq[0]===seq[4])
    return { next: seq[0], conf: 0.66 };
  return null;
}

// ── Cầu 3-3 chuyên biệt ──────────────────────────────────────
function algoCau33(seq) {
  if (seq.length < 12) return null;
  if (seq.slice(0,3).every(x=>x===seq[0]) && seq.slice(3,6).every(x=>x!==seq[0]) &&
      seq.slice(6,9).every(x=>x===seq[0]) && seq.slice(9,12).every(x=>x!==seq[0]))
    return { next: seq[0], conf: 0.65 };
  return null;
}

// ── Cầu Zigzag phát hiện ─────────────────────────────────────
function algoCauZigZag(seq) {
  if (seq.length < 10) return null;
  // TXTXTXTXTX hoặc TXTXTXTXT
  let zz = true;
  for (let i = 1; i < Math.min(seq.length, 10); i++) {
    if (seq[i] === seq[i-1]) { zz = false; break; }
  }
  if (zz) return { next: seq[0] === "T" ? "X" : "T", conf: 0.70 };
  return null;
}

// ── Cầu Phá / Đảo chiều bệt ──────────────────────────────────
function algoCauBreak(seq) {
  if (seq.length < 6) return null;
  let bLen = 1;
  while (bLen < seq.length && seq[bLen] === seq[0]) bLen++;
  if (bLen >= 4) {
    // Bệt đủ dài → dự đoán phá
    return { next: seq[0] === "T" ? "X" : "T", conf: 0.55 + Math.min(bLen * 0.02, 0.12) };
  }
  return null;
}

// ── Khoảng cách giữa 2 lần đảo chiều ────────────────────────
function algoCauGap(seq) {
  if (seq.length < 15) return null;
  const gaps = [];
  let g = 1;
  for (let i = 1; i < seq.length; i++) {
    if (seq[i] === seq[i-1]) g++;
    else { gaps.push(g); g = 1; }
  }
  if (gaps.length < 4) return null;
  const avg = gaps.slice(0,4).reduce((a,b)=>a+b,0)/4;
  let cur = 1; while (cur < seq.length && seq[cur]===seq[0]) cur++;
  if (cur >= Math.round(avg)) return { next: seq[0]==="T"?"X":"T", conf: 0.58 };
  return null;
}

// ── Block: TTTXXX hoặc XXXTTT ────────────────────────────────
function algoCauBlock(seq) {
  if (seq.length < 6) return null;
  const first = seq[0];
  if (seq.slice(0,3).every(x=>x===first) && seq.slice(3,6).every(x=>x!==first))
    return { next: first, conf: 0.61 };
  return null;
}

// ── Gương đảo chiều ──────────────────────────────────────────
function algoCauMirror(seq) {
  if (seq.length < 7) return null;
  // Dạng TXTTTXT (đối xứng qua giữa)
  const mid = Math.floor(seq.length / 2);
  const half = seq.slice(0, mid);
  const rev  = seq.slice(1, mid+1).reverse();
  let match = 0;
  for (let i = 0; i < half.length; i++) if (half[i] === rev[i]) match++;
  if (match / half.length >= 0.85)
    return { next: seq[0]==="T"?"X":"T", conf: 0.59 };
  return null;
}

// ── Tăng tốc Tài / Xỉu ───────────────────────────────────────
function algoCauAccel(seq) {
  if (seq.length < 12) return null;
  const c1 = seq.slice(0,4).filter(x=>x==="T").length;
  const c2 = seq.slice(4,8).filter(x=>x==="T").length;
  const c3 = seq.slice(8,12).filter(x=>x==="T").length;
  if (c1 > c2 && c2 > c3) return { next: "T", conf: 0.58 }; // đang tăng dần T
  if (c1 < c2 && c2 < c3) return { next: "X", conf: 0.58 }; // đang giảm T
  return null;
}

// ── Chẵn/lẻ luân phiên ───────────────────────────────────────
function algoParity(hist) {
  if (hist.length < 6) return null;
  const parSeq = hist.slice(0,6).map(h => {
    const sum = h.dice?.sum ?? null;
    if (sum === null) return null;
    return sum % 2 === 0 ? "C" : "L";
  });
  if (parSeq.some(x=>x===null)) return null;
  // Xen kẽ C-L ≥ 4 lần
  let alt = 1;
  for (let i = 1; i < parSeq.length; i++) {
    if (parSeq[i] !== parSeq[i-1]) alt++;
    else break;
  }
  if (alt >= 4) {
    // Dự đoán ngược chẵn lẻ → không ảnh hưởng T/X trực tiếp
    // Dùng để tăng trọng lượng hiện tại
    return { next: hist[0].type === "T" ? "X" : "T", conf: 0.57 };
  }
  return null;
}

// ── Xu hướng tổng xúc xắc ────────────────────────────────────
function algoSumTrend(hist) {
  if (hist.length < 10) return null;
  const sums = hist.slice(0,10).map(h=>h.dice?.sum??null).filter(x=>x!==null);
  if (sums.length < 8) return null;
  const recent = sums.slice(0,4).reduce((a,b)=>a+b,0)/4;
  const older  = sums.slice(4,8).reduce((a,b)=>a+b,0)/4;
  if (recent - older > 1.5) return { next: "T", conf: 0.57 };
  if (older - recent > 1.5) return { next: "X", conf: 0.57 };
  return null;
}

// ── Cao/thấp xen kẽ ──────────────────────────────────────────
function algoHighLow(hist) {
  if (hist.length < 8) return null;
  const sums = hist.slice(0,8).map(h=>h.dice?.sum??null);
  if (sums.some(x=>x===null)) return null;
  let hl = 0;
  for (let i = 1; i < sums.length; i++) {
    if ((sums[i-1] > 10 && sums[i] <= 10) || (sums[i-1] <= 10 && sums[i] > 10)) hl++;
    else break;
  }
  if (hl >= 5) return { next: hist[0].type === "T" ? "X" : "T", conf: 0.62 };
  return null;
}

// ── Khối xen kẽ 2-2-2 ────────────────────────────────────────
function algoAltBlock(seq) {
  if (seq.length < 12) return null;
  if (seq[0]===seq[1] && seq[2]===seq[3] && seq[0]!==seq[2] &&
      seq[4]===seq[5] && seq[4]===seq[0] && seq[6]===seq[7] && seq[6]===seq[2] &&
      seq[8]===seq[9] && seq[8]===seq[0])
    return { next: seq[0], conf: 0.64 };
  return null;
}

// ══════════════════════════════════════════════════════════════
// GIỚI HẠN: KHÔNG DỰ ĐOÁN 1 BÊN QUÁ 3 LẦN LIÊN TIẾP
// ══════════════════════════════════════════════════════════════
let consecutivePred = { side: null, count: 0 };

function applyConsecutiveLimit(next, conf, seq) {
  if (consecutivePred.side === next) {
    if (consecutivePred.count >= 3) {
      // Buộc đổi bên
      const forced = next === "T" ? "X" : "T";
      // Tính lại conf dựa trên dữ liệu gần nhất
      const recentT = seq.slice(0,10).filter(x=>x==="T").length / Math.min(seq.length,10);
      const forcedConf = forced === "T" ? (0.50 + recentT * 0.15) : (0.50 + (1-recentT) * 0.15);
      return { next: forced, conf: Math.round(Math.min(Math.max(forcedConf, 0.50), 0.75) * 100) };
    }
  }
  return null; // không cần override
}

// ══════════════════════════════════════════════════════════════
// ENSEMBLE
// ══════════════════════════════════════════════════════════════
function predict(hist) {
  if (hist.length < 3) return {
    next: "?", conf: 0, cauType: "Chưa đủ dữ liệu",
    votesT: 0, votesX: 0
  };

  const seq = hist.map(h => h.type);
  const wSum = { T: 0, X: 0 };
  const votes = [];

  const add = (name, res, base) => {
    if (!res) return;
    lastPreds[name] = res.next;
    const w = base * getWeight(name);
    wSum[res.next] += res.conf * w;
    votes.push({ algo: name, pred: res.next });
  };

  const pat = detectPattern(seq);
  add("pattern",     pat,                                 5.0);
  add("contrarian",  algoContrarian(hist),                4.0);
  add("ratio",       algoRatio(hist),                     3.5);
  add("ratioMa",     algoRatioMa(hist),                   2.5);

  // Markov bậc cao (10 → 4: trọng lượng giảm dần)
  add("markov10",    algoMarkovN(seq,10,3),               5.0);
  add("markov9",     algoMarkovN(seq, 9,3),               4.8);
  add("markov8",     algoMarkovN(seq, 8,3),               4.5);
  add("markov7",     algoMarkovN(seq, 7,3),               4.2);
  add("markov6",     algoMarkovN(seq, 6,3),               4.0);
  add("markov5",     algoMarkovN(seq, 5,4),               3.8);
  add("markov4",     algoMarkovN(seq, 4,4),               3.5);
  add("markov3",     algoMarkovN(seq, 3,5),               3.5);
  add("markov2",     algoMarkovN(seq, 2,6),               3.0);
  add("markov1",     algoMarkovN(seq, 1,6),               2.5);

  add("ngram4",      algoNgram4(seq),                     2.5);
  add("bayesian",    algoBayesian(seq),                   2.0);
  add("streak5",     algoStreak5(seq),                    2.0);
  add("autocorr",    algoAutoCorr(seq),                   1.8);
  add("chiSq",       algoChiSq(seq),                      1.8);
  add("luong",       algoLuong(seq),                      1.5);
  add("momentum",    algoMomentum(seq),                   1.5);
  add("freq",        algoFreq(seq),                       1.5);
  add("trendFollow", algoTrendFollow(seq),                1.2);
  add("chuky",       algoChuKy(seq),                      1.2);
  add("entropy",     algoEntropy(seq),                    1.0);
  add("reversal",    algoReversal(seq),                   1.0);
  add("streakLen",   algoStreakLen(seq),                  1.0);

  // Cầu chuyên biệt
  add("cau11",       algoCau11(seq),                      2.0);
  add("cau22",       algoCau22(seq),                      1.8);
  add("cau33",       algoCau33(seq),                      1.8);
  add("cauZigZag",   algoCauZigZag(seq),                  2.2);
  add("cauBreak",    algoCauBreak(seq),                   1.5);
  add("cauGap",      algoCauGap(seq),                     1.3);
  add("cauBlock",    algoCauBlock(seq),                   1.3);
  add("cauMirror",   algoCauMirror(seq),                  1.0);
  add("cauAccel",    algoCauAccel(seq),                   1.2);

  // Phân tích dice
  add("parity",      algoParity(hist),                    1.5);
  add("sumTrend",    algoSumTrend(hist),                  1.5);
  add("highLow",     algoHighLow(hist),                   1.3);
  add("altBlock",    algoAltBlock(seq),                   1.2);

  const tot = wSum.T + wSum.X;
  let next = "T", conf = 0.50;
  if (tot > 0) {
    if (wSum.X > wSum.T) { next = "X"; conf = wSum.X / tot; }
    else                 { next = "T"; conf = wSum.T / tot; }
  }
  conf = Math.min(Math.max(conf, 0.50), 0.90);

  // ── Giới hạn không dự đoán 1 bên quá 3 lần ──────────────
  const override = applyConsecutiveLimit(next, conf, seq);
  if (override) {
    next = override.next;
    conf = override.conf / 100;
    consecutivePred = { side: next, count: 1 };
  } else {
    if (consecutivePred.side === next) consecutivePred.count++;
    else consecutivePred = { side: next, count: 1 };
  }

  const cauType = pat ? pat.name
    : wSum.T > wSum.X ? "Nghiêng Tài"
    : wSum.X > wSum.T ? "Nghiêng Xỉu"
    : "Cân bằng";

  return {
    next,
    conf:    Math.round(conf * 100),
    cauType,
    votesT:  votes.filter(v=>v.pred==="T").length,
    votesX:  votes.filter(v=>v.pred==="X").length
  };
}

// ══════════════════════════════════════════════════════════════
// SYNC
// ══════════════════════════════════════════════════════════════
async function syncHistory() {
  try {
    const res = await fetchSource();
    if (!res.ok || !res.body) return;
    const parsed = parseBody(res.body);
    ingest(parsed);
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════════
// HTTP SERVER
// ══════════════════════════════════════════════════════════════
http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, "http://localhost");

  // ── /predict ────────────────────────────────────────────────
  if (url.pathname === "/predict" || url.pathname === "/") {
    await syncHistory();

    const lastLocked = history[0] ?? null;
    const cur        = pendingSession ?? lastLocked;

    if (!cur) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "Chưa có dữ liệu" }));
      return;
    }

    const ketQua = lastLocked
      ? (lastLocked.type === "T" ? "Tài" : "Xỉu")
      : null;

    const diceSource = lastLocked?.dice ?? (lastDice ?? null);
    const xucXac     = diceSource ? [diceSource.d1, diceSource.d2, diceSource.d3] : null;

    const phienHienTai = Number(lastLocked?.phien ?? cur.phien);
    const phienDuDoan  = pendingSession
      ? Number(pendingSession.phien)
      : phienHienTai + 1;

    const pred = predict(history);

    const pattern = history
      .slice(0, 30)
      .map(h => h.type === "T" ? "t" : "x")
      .join("");

    res.writeHead(200);
    res.end(JSON.stringify({
      phien_hien_tai: phienHienTai,
      ket_qua:        ketQua,
      xuc_xac:        xucXac,
      phien_du_doan:  phienDuDoan,
      du_doan:        pred.next === "T" ? "Tài" : "Xỉu",
      do_tin_cay:     pred.conf + "%",
      pattern,
      id:             BOT_ID
    }));
    return;
  }

  // ── /history ─────────────────────────────────────────────────
  if (url.pathname === "/history") {
    await syncHistory();
    const lim = Math.min(parseInt(url.searchParams.get("limit") || "20"), 200);
    res.writeHead(200);
    res.end(JSON.stringify({
      total: history.length,
      data:  history.slice(0, lim).map(h => ({
        phien:      h.phien,
        tai_pct:    Math.round(h.ratio * 100) + "%",
        xiu_pct:    Math.round((1 - h.ratio) * 100) + "%",
        cuoc_tai:   h.sTB,
        cuoc_xiu:   h.bTB,
        nguoi_tai:  h.sTU,
        nguoi_xiu:  h.bTU,
        xuc_xac:    h.dice ? [h.dice.d1, h.dice.d2, h.dice.d3] : null,
        ket_qua:    h.type === "T" ? "Tài" : "Xỉu"
      }))
    }));
    return;
  }

  // ── /pattern ──────────────────────────────────────────────────
  if (url.pathname === "/pattern") {
    await syncHistory();
    if (!history.length) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "Chưa có dữ liệu" }));
      return;
    }
    const seq = history.map(h => h.type);
    const pat = detectPattern(seq);
    const streaks = []; let curS = { v: seq[0], len: 1 };
    for (let i = 1; i < Math.min(seq.length, 30); i++) {
      if (seq[i] === curS.v) curS.len++;
      else { streaks.push({ ...curS }); curS = { v: seq[i], len: 1 }; }
    }
    streaks.push(curS);
    res.writeHead(200);
    res.end(JSON.stringify({
      pattern_20:     seq.slice(0,20).map(x=>x==="T"?"t":"x").join(""),
      cau_hien_tai:   pat ? pat.name : "Không rõ cầu",
      do_tin_cay_cau: pat ? Math.round(pat.conf*100)+"%" : "N/A",
      chuoi_gan:      streaks.slice(0,8).map(s => ({
        ket_qua:  s.v === "T" ? "Tài" : "Xỉu",
        so_phien: s.len
      }))
    }));
    return;
  }

  // ── /stats ────────────────────────────────────────────────────
  if (url.pathname === "/stats") {
    const out = {};
    for (const n of ALGOS) {
      const a = acc[n];
      out[n] = {
        do_chinh_xac: a.t ? Math.round(a.c/a.t*100)+"%" : "N/A",
        trong_so:     Math.round(getWeight(n)*100)/100,
        mau:          Math.round(a.t)
      };
    }
    res.writeHead(200);
    res.end(JSON.stringify({ algo_stats: out, history_count: history.length, source: SOURCE_URL }));
    return;
  }

  // ── /debug ────────────────────────────────────────────────────
  if (url.pathname === "/debug") {
    const r = await fetchSource().catch(e => ({ error: e.message }));
    res.writeHead(200);
    res.end(JSON.stringify({
      raw_api:         r,
      pending_session: pendingSession,
      last_dice:       lastDice,
      last_locked:     history[0] ?? null,
      history_count:   history.length,
      consecutive_pred: consecutivePred
    }, null, 2));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({
    error: "Không tìm thấy",
    endpoints: ["/predict", "/history", "/pattern", "/stats", "/debug"]
  }));

}).listen(PORT, () => {
  console.log("✅ Sic-bo prediction server port " + PORT);
  console.log("   Source: " + SOURCE_URL);
  syncHistory();
  setInterval(syncHistory, 10000);
});
