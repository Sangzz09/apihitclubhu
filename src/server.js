const https = require("https");
const http  = require("http");

const SOURCE_URL  = "https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=g8&gid=vgmn_100";
const PORT        = process.env.PORT || 3000;
const HISTORY_MAX = 500;

// ══════════════════════════════════════════════════════════════
//  JSON cấu trúc:
//  data[0] = { sid, cmd, gi:[{ B:{tU,tB}, S:{tU,tB}, aid }] }
//  B = Bé/Xỉu (Small),  S = Sộ/Tài (Big)
//  ratio = S.tB / (B.tB + S.tB)  →  tỷ lệ tiền cược Tài
//
//  Vì API không trả dice/kết quả trực tiếp, kết quả phiên được
//  suy ra bằng contrarian logic: đám đông cược Tài → Xỉu thắng
// ══════════════════════════════════════════════════════════════
let history        = [];   // newest → oldest
let lastSid        = null;
let pendingSession = null; // phiên đang chạy (chưa khoá)

// ══════════════════════════════════════════════════════════════
//  FETCH
// ══════════════════════════════════════════════════════════════
function fetchSource() {
  return new Promise((resolve, reject) => {
    const req = https.get(SOURCE_URL, {
      headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }
    }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try   { resolve({ ok: true, body: JSON.parse(raw) }); }
        catch { resolve({ ok: false, raw: raw.slice(0, 800) }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(14000, () => { req.destroy(); reject(new Error("timeout")); });
  });
}

// ══════════════════════════════════════════════════════════════
//  PARSE
// ══════════════════════════════════════════════════════════════
function parseBody(body) {
  if (!body || body.status !== "OK") return null;
  const entry = Array.isArray(body.data) ? body.data[0] : null;
  if (!entry) return null;

  const sid = String(entry.sid ?? "?");
  const gi  = Array.isArray(entry.gi) ? entry.gi[0] : null;
  if (!gi) return null;

  const bTB   = Number(gi.B?.tB ?? 0);   // tiền cược Xỉu
  const sTB   = Number(gi.S?.tB ?? 0);   // tiền cược Tài
  const bTU   = Number(gi.B?.tU ?? 0);   // người cược Xỉu
  const sTU   = Number(gi.S?.tU ?? 0);   // người cược Tài
  const total = bTB + sTB;
  const ratio = total > 0 ? sTB / total : 0.5; // tỷ lệ tiền Tài [0..1]

  return { sid, bTB, sTB, bTU, sTU, ratio, total };
}

// ══════════════════════════════════════════════════════════════
//  SUY RA KẾT QUẢ từ tỷ lệ cược
// ══════════════════════════════════════════════════════════════
function inferType(ratio, prevType) {
  if (ratio > 0.58) return "X";   // đám đông Tài → Xỉu thắng
  if (ratio < 0.42) return "T";   // đám đông Xỉu → Tài thắng
  return prevType ?? (ratio >= 0.5 ? "X" : "T");
}

// ══════════════════════════════════════════════════════════════
//  INGEST: khi sid thay đổi → khoá phiên cũ vào history
// ══════════════════════════════════════════════════════════════
function ingest(parsed) {
  const { sid, bTB, sTB, bTU, sTU, ratio, total } = parsed;

  if (sid === lastSid) {
    // Cùng phiên → cập nhật live
    if (pendingSession) {
      Object.assign(pendingSession, { bTB, sTB, bTU, sTU, ratio, total });
    } else {
      pendingSession = { phien: sid, bTB, sTB, bTU, sTU, ratio, total };
    }
    return false;
  }

  // Phiên mới → khoá pending vào history
  if (pendingSession) {
    const prevType = history[0]?.type ?? null;
    pendingSession.type = inferType(pendingSession.ratio, prevType);
    history.unshift(pendingSession);
    if (history.length > HISTORY_MAX) history = history.slice(0, HISTORY_MAX);
  }

  pendingSession = { phien: sid, bTB, sTB, bTU, sTU, ratio, total };
  lastSid = sid;
  return true;
}

// ══════════════════════════════════════════════════════════════
//  SELF-CALIBRATING WEIGHT
// ══════════════════════════════════════════════════════════════
const ALGOS = [
  "pattern","markov3","markov2","markov1",
  "freq","luong","streak5","entropy",
  "chuky","autocorr","momentum","bayesian",
  "ngram4","reversal","chiSq","trendFollow",
  "streakLen","ratio","ratioMa","contrarian"
];
const acc = {};
for (const n of ALGOS) acc[n] = { c: 20, t: 40 };

function updateAcc(name, pred, actual) {
  if (!acc[name]) return;
  acc[name].t++;
  if (pred === actual) acc[name].c++;
  if (acc[name].t > 80) { acc[name].c *= 80/acc[name].t; acc[name].t = 80; }
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
//  PATTERN DETECTION
// ══════════════════════════════════════════════════════════════
function detectPattern(seq) {
  if (seq.length < 4) return null;
  const s = seq.join("");

  // Bệt
  const bm = s.match(/^(T{3,}|X{3,})/);
  if (bm) {
    const len  = bm[0].length;
    const same = bm[0][0];
    const next = len >= 7 ? (same==="T"?"X":"T") : same;
    const conf = len >= 7 ? 0.70 : Math.min(0.54 + len*0.03, 0.80);
    return { name:`Bệt ${same==="T"?"Tài":"Xỉu"}(${len})`, next, conf };
  }

  // Cầu 1-1
  let alt = 0;
  for (let i = 0; i < Math.min(seq.length, 12); i++) {
    if (i===0 || seq[i]!==seq[i-1]) alt++;
    else break;
  }
  if (alt >= 6) return { name:"Cầu 1-1 dài", next: seq[0]==="T"?"X":"T", conf:0.73 };
  if (alt >= 4) return { name:"Cầu 1-1",      next: seq[0]==="T"?"X":"T", conf:0.64 };

  // Cầu 2-2
  if (s.length>=8 && s[0]===s[1] && s[2]===s[3] && s[0]!==s[2] && s[4]===s[5] && s[0]===s[4])
    return { name:"Cầu 2-2", next:s[0], conf:0.68 };
  if (s.length>=6 && s[0]!==s[1] && s[1]===s[2] && s[3]===s[4] && s[1]!==s[3])
    return { name:"Cầu 2-2 giữa", next:s[0]==="T"?"X":"T", conf:0.63 };

  // Cầu 3-3
  if (s.length>=6 && s[0]===s[1] && s[1]===s[2] && s[3]===s[4] && s[4]===s[5] && s[0]!==s[3])
    return { name:"Cầu 3-3", next:s[0], conf:0.65 };

  // Cầu 4-4
  if (s.length>=8 && s.slice(0,4).split("").every(c=>c===s[0]) &&
      s.slice(4,8).split("").every(c=>c===s[4]) && s[0]!==s[4])
    return { name:"Cầu 4-4", next:s[0], conf:0.66 };

  // Cầu 2-1
  if (s.length>=6 && s[0]===s[1] && s[2]!==s[1] && s[3]===s[4] && s[5]!==s[4] && s[0]===s[3])
    return { name:"Cầu 2-1", next:s[0], conf:0.62 };

  // Cầu 1-2
  if (s.length>=6 && s[0]!==s[1] && s[1]===s[2] && s[3]!==s[4] && s[4]===s[5])
    return { name:"Cầu 1-2", next:s[0], conf:0.61 };

  // Chu kỳ 2/3/4
  for (const p of [2,3,4]) {
    if (s.length >= p*3) {
      const c = s.slice(0,p);
      if (s.slice(p,p*2)===c && s.slice(p*2,p*3)===c)
        return { name:`Chu Kỳ ${p}`, next:c[0], conf:0.65+p*0.01 };
    }
  }

  // Cầu gương
  if (s.length>=5 && s[0]===s[4] && s[1]===s[3] && s[1]!==s[0])
    return { name:"Cầu Gương", next:s[1]==="T"?"X":"T", conf:0.60 };

  return null;
}

// ══════════════════════════════════════════════════════════════
//  ALGORITHMS
// ══════════════════════════════════════════════════════════════
function algoMarkov3(seq) {
  if (seq.length<20) return null;
  const t={};
  for (let i=0;i<seq.length-3;i++) {
    const k=seq[i+3]+seq[i+2]+seq[i+1];
    if(!t[k]) t[k]={T:0,X:0};
    t[k][seq[i]]++;
  }
  const k=seq[2]+seq[1]+seq[0]; const row=t[k]; if(!row) return null;
  const tot=row.T+row.X; if(tot<5) return null;
  if(row.T>row.X) return {next:"T",conf:0.50+(row.T/tot-0.50)*0.68};
  if(row.X>row.T) return {next:"X",conf:0.50+(row.X/tot-0.50)*0.68};
  return null;
}

function algoMarkov2(seq) {
  if (seq.length<15) return null;
  const t={};
  for (let i=0;i<seq.length-2;i++) {
    const k=seq[i+2]+seq[i+1];
    if(!t[k]) t[k]={T:0,X:0};
    t[k][seq[i]]++;
  }
  const k=seq[1]+seq[0]; const row=t[k]; if(!row) return null;
  const tot=row.T+row.X; if(tot<6) return null;
  if(row.T>row.X) return {next:"T",conf:0.50+(row.T/tot-0.50)*0.70};
  if(row.X>row.T) return {next:"X",conf:0.50+(row.X/tot-0.50)*0.70};
  return null;
}

function algoMarkov1(seq) {
  if (seq.length<10) return null;
  const t={T:{T:0,X:0},X:{T:0,X:0}};
  for (let i=0;i<seq.length-1;i++) t[seq[i+1]][seq[i]]++;
  const row=t[seq[0]]; const tot=row.T+row.X; if(tot<6) return null;
  if(row.T>row.X) return {next:"T",conf:0.50+(row.T/tot-0.50)*0.65};
  if(row.X>row.T) return {next:"X",conf:0.50+(row.X/tot-0.50)*0.65};
  return null;
}

function algoFreq(seq) {
  const n20=Math.min(seq.length,20), n50=Math.min(seq.length,50);
  const rT=seq.slice(0,n20).filter(x=>x==="T").length/n20*0.6
           +seq.slice(0,n50).filter(x=>x==="T").length/n50*0.4;
  const rX=1-rT;
  if(rT>0.60) return {next:"X",conf:0.50+(rT-0.50)*0.60};
  if(rX>0.60) return {next:"T",conf:0.50+(rX-0.50)*0.60};
  return null;
}

function algoLuong(seq) {
  if(seq.length<8) return null;
  const w=seq.slice(0,8); let tr=0;
  for(let i=1;i<w.length;i++) if(w[i]!==w[i-1]) tr++;
  if(tr<=1) return {next:w[0],conf:0.64};
  if(tr>=7) return {next:w[0]==="T"?"X":"T",conf:0.64};
  return null;
}

function algoStreak5(seq) {
  if(seq.length<5) return null;
  const f=seq[0];
  if(seq.slice(0,5).every(x=>x===f)) return {next:f==="T"?"X":"T",conf:0.67};
  return null;
}

function algoEntropy(seq) {
  const n=Math.min(seq.length,20); const sub=seq.slice(0,n);
  let tr=0; for(let i=1;i<sub.length;i++) if(sub[i]!==sub[i-1]) tr++;
  const e=tr/(n-1);
  if(e>0.38&&e<0.62) return null;
  if(e<=0.38) return {next:sub[0],conf:0.61};
  return {next:sub[0]==="T"?"X":"T",conf:0.59};
}

function algoChuKy(seq) {
  if(seq.length<12) return null;
  for(let p=2;p<=6;p++) {
    let match=0,total=0;
    for(let i=0;i<Math.min(seq.length-p,20);i++) {
      if(seq[i+p]!==undefined){total++;if(seq[i]===seq[i+p])match++;}
    }
    if(total>=6&&match/total>=0.75) return {next:seq[p-1]??seq[0],conf:0.56+(match/total-0.75)*0.5};
  }
  return null;
}

function algoAutoCorr(seq) {
  if(seq.length<20) return null;
  const n=Math.min(seq.length,40);
  const v=seq.slice(0,n).map(x=>x==="T"?1:0);
  const mean=v.reduce((a,b)=>a+b,0)/n;
  let ac1=0,denom=0;
  for(let i=0;i<n;i++) denom+=(v[i]-mean)**2;
  for(let i=1;i<n;i++) ac1+=(v[i]-mean)*(v[i-1]-mean);
  ac1/=denom;
  if(ac1>0.15) return {next:seq[0],conf:0.54+Math.min(ac1*0.4,0.10)};
  if(ac1<-0.15) return {next:seq[0]==="T"?"X":"T",conf:0.54+Math.min(-ac1*0.4,0.10)};
  return null;
}

function algoMomentum(seq) {
  if(seq.length<30) return null;
  const s=seq.slice(0,5).filter(x=>x==="T").length/5;
  const l=seq.slice(0,20).filter(x=>x==="T").length/20;
  const d=s-l;
  if(d>0.25) return {next:"T",conf:0.55+Math.min(d*0.3,0.08)};
  if(d<-0.25) return {next:"X",conf:0.55+Math.min(-d*0.3,0.08)};
  return null;
}

function algoBayesian(seq) {
  if(seq.length<15) return null;
  let logOdds=0;
  for(const w of [3,5,8,13]) {
    const sub=seq.slice(0,Math.min(w,seq.length));
    const pT=(sub.filter(x=>x==="T").length+1)/(sub.length+2);
    logOdds+=Math.log(pT/(1-pT))/4;
  }
  const pT=1/(1+Math.exp(-logOdds));
  if(pT>0.58) return {next:"T",conf:0.50+(pT-0.50)*0.8};
  if(pT<0.42) return {next:"X",conf:0.50+(0.50-pT)*0.8};
  return null;
}

function algoNgram4(seq) {
  if(seq.length<25) return null;
  const t={};
  for(let i=0;i<seq.length-4;i++){
    const k=seq[i+4]+seq[i+3]+seq[i+2]+seq[i+1];
    if(!t[k]) t[k]={T:0,X:0};
    t[k][seq[i]]++;
  }
  const k=seq[3]+seq[2]+seq[1]+seq[0]; const row=t[k]; if(!row) return null;
  const tot=row.T+row.X; if(tot<4) return null;
  if(row.T>row.X) return {next:"T",conf:0.50+(row.T/tot-0.50)*0.72};
  if(row.X>row.T) return {next:"X",conf:0.50+(row.X/tot-0.50)*0.72};
  return null;
}

function algoReversal(seq) {
  if(seq.length<20) return null;
  let sLen=1; while(sLen<seq.length&&seq[sLen]===seq[0]) sLen++;
  if(sLen<2) return null;
  let rev=0,samp=0;
  for(let i=sLen;i<seq.length-sLen;i++){
    if(seq.slice(i,i+sLen).every(x=>x===seq[i])){
      samp++; if(seq[i-1]!==seq[i]) rev++; i+=sLen-1;
    }
  }
  if(samp<3) return null;
  const pr=rev/samp;
  if(pr>0.65) return {next:seq[0]==="T"?"X":"T",conf:0.52+pr*0.10};
  if(pr<0.35) return {next:seq[0],conf:0.52+(1-pr)*0.10};
  return null;
}

function algoChiSq(seq) {
  if(seq.length<30) return null;
  const obs={TT:0,TX:0,XT:0,XX:0};
  for(let i=0;i<seq.length-1;i++){const k=seq[i+1]+seq[i];if(obs[k]!==undefined)obs[k]++;}
  const n=Object.values(obs).reduce((a,b)=>a+b,0);
  const exp=n/4;
  const chi2=Object.values(obs).reduce((s,o)=>s+(o-exp)**2/exp,0);
  if(chi2<3.84) return null;
  const pTT=obs.TT/(obs.TT+obs.TX+0.001);
  const pXX=obs.XX/(obs.XX+obs.XT+0.001);
  if(seq[0]==="T"&&pTT>0.60) return {next:"T",conf:0.52+pTT*0.10};
  if(seq[0]==="T"&&pTT<0.40) return {next:"X",conf:0.52+(1-pTT)*0.10};
  if(seq[0]==="X"&&pXX>0.60) return {next:"X",conf:0.52+pXX*0.10};
  if(seq[0]==="X"&&pXX<0.40) return {next:"T",conf:0.52+(1-pXX)*0.10};
  return null;
}

function algoTrendFollow(seq) {
  if(seq.length<12) return null;
  const v=seq.slice(0,20).map(x=>x==="T"?1:0);
  const ema=(arr,a)=>arr.reduce((e,x,i)=>i===0?x:a*x+(1-a)*e,arr[0]);
  const e5=ema(v.slice(0,5),0.4), e12=ema(v.slice(0,12),0.2);
  if(e5>e12+0.08) return {next:"T",conf:0.55};
  if(e5<e12-0.08) return {next:"X",conf:0.55};
  return null;
}

function algoStreakLen(seq) {
  if(seq.length<20) return null;
  const streaks=[]; let cur=1;
  for(let i=1;i<seq.length;i++){
    if(seq[i]===seq[i-1])cur++;
    else{streaks.push(cur);cur=1;}
  }
  streaks.push(cur);
  if(streaks.length<4) return null;
  const avgLen=streaks.reduce((a,b)=>a+b,0)/streaks.length;
  let curLen=1; while(curLen<seq.length&&seq[curLen]===seq[0]) curLen++;
  if(curLen>=Math.ceil(avgLen*1.5)) return {next:seq[0]==="T"?"X":"T",conf:0.57};
  if(curLen===1&&curLen<avgLen*0.6) return {next:seq[0],conf:0.54};
  return null;
}

// Ratio-based (dùng tỷ lệ tiền cược thực tế từ API)
function algoRatio(hist) {
  if(!hist.length) return null;
  const r=hist[0].ratio;
  if(r>0.62) return {next:"X",conf:0.50+(r-0.50)*0.55};
  if(r<0.38) return {next:"T",conf:0.50+(0.50-r)*0.55};
  return null;
}

function algoRatioMa(hist) {
  if(hist.length<5) return null;
  const ma=hist.slice(0,5).reduce((s,h)=>s+h.ratio,0)/5;
  if(ma>0.60) return {next:"X",conf:0.52+(ma-0.50)*0.40};
  if(ma<0.40) return {next:"T",conf:0.52+(0.50-ma)*0.40};
  return null;
}

function algoContrarian(hist) {
  if(hist.length<10) return null;
  const avgTotal=hist.slice(1,11).reduce((s,h)=>s+(h.total||0),0)/10;
  const cur=hist[0];
  if((cur.total||0) < avgTotal*0.5) return null;
  const r=cur.ratio;
  if(r>0.65) return {next:"X",conf:0.58+(r-0.65)*0.40};
  if(r<0.35) return {next:"T",conf:0.58+(0.35-r)*0.40};
  return null;
}

// ══════════════════════════════════════════════════════════════
//  ENSEMBLE — chỉ dự đoán 1 phiên tiếp theo
// ══════════════════════════════════════════════════════════════
function predict(hist) {
  if (hist.length < 3) return {
    next:"?", conf:0, cauType:"Chưa đủ dữ liệu",
    pattern:"", votesT:0, votesX:0, detail:{}
  };

  const seq  = hist.map(h => h.type);
  const wSum = { T:0, X:0 };
  const detail = {}, votes = [];

  const add = (name, res, base) => {
    if (!res) { detail[name] = null; return; }
    lastPreds[name] = res.next;
    const w = base * getWeight(name);
    wSum[res.next] += res.conf * w;
    detail[name] = { next:res.next, conf:Math.round(res.conf*100), w:Math.round(w*100)/100 };
    votes.push({ algo:name, pred:res.next });
  };

  const pat = detectPattern(seq);
  add("pattern",     pat,                     5.0);
  add("contrarian",  algoContrarian(hist),    4.0);
  add("ratio",       algoRatio(hist),         3.5);
  add("ratioMa",     algoRatioMa(hist),       2.5);
  add("markov3",     algoMarkov3(seq),        3.5);
  add("markov2",     algoMarkov2(seq),        3.0);
  add("markov1",     algoMarkov1(seq),        2.5);
  add("ngram4",      algoNgram4(seq),         2.5);
  add("bayesian",    algoBayesian(seq),       2.0);
  add("streak5",     algoStreak5(seq),        2.0);
  add("autocorr",    algoAutoCorr(seq),       1.8);
  add("chiSq",       algoChiSq(seq),          1.8);
  add("luong",       algoLuong(seq),          1.5);
  add("momentum",    algoMomentum(seq),       1.5);
  add("freq",        algoFreq(seq),           1.5);
  add("trendFollow", algoTrendFollow(seq),    1.2);
  add("chuky",       algoChuKy(seq),          1.2);
  add("entropy",     algoEntropy(seq),        1.0);
  add("reversal",    algoReversal(seq),       1.0);
  add("streakLen",   algoStreakLen(seq),       1.0);

  const tot = wSum.T + wSum.X;
  let next = "T", conf = 0.50;
  if (tot > 0) {
    if (wSum.X > wSum.T) { next = "X"; conf = wSum.X / tot; }
    else                  { next = "T"; conf = wSum.T / tot; }
  }
  conf = Math.min(Math.max(conf, 0.50), 0.90);

  const patStr  = seq.slice(0, 16).join("");
  const cauType = pat ? pat.name
    : wSum.T > wSum.X ? "Nghiêng Tài"
    : wSum.X > wSum.T ? "Nghiêng Xỉu"
    : "Cân Bằng";

  return {
    next:    next === "T" ? "Tài" : "Xỉu",
    raw:     next,
    conf:    Math.round(conf * 100),
    cauType,
    pattern: patStr,
    votesT:  votes.filter(v => v.pred === "T").length,
    votesX:  votes.filter(v => v.pred === "X").length,
    detail
  };
}

// ══════════════════════════════════════════════════════════════
//  SYNC
// ══════════════════════════════════════════════════════════════
async function syncHistory() {
  try {
    const res = await fetchSource();
    if (!res.ok || !res.body) return;
    const parsed = parseBody(res.body);
    if (!parsed) return;
    const isNew = ingest(parsed);
    if (isNew && history.length >= 2) recordActual(history[0].type);
  } catch (_) {}
}

// ══════════════════════════════════════════════════════════════
//  HTTP SERVER
// ══════════════════════════════════════════════════════════════
http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, "http://localhost");

  // ── /predict  (dự đoán 1 phiên tiếp theo) ─────────────────
  if (url.pathname === "/predict" || url.pathname === "/") {
    await syncHistory();
    const cur = pendingSession ?? history[0];
    if (!cur) {
      res.writeHead(503);
      res.end(JSON.stringify({ error:"Chưa có dữ liệu" }));
      return;
    }
    const pred    = predict(history);
    const ratioPct = Math.round((cur.ratio ?? 0.5) * 100);
    res.writeHead(200);
    res.end(JSON.stringify({
      phien_hien_tai:  cur.phien,
      cuoc_tai:        `${(cur.sTB||0).toLocaleString()} (${ratioPct}%)`,
      cuoc_xiu:        `${(cur.bTB||0).toLocaleString()} (${100-ratioPct}%)`,
      nguoi_cuoc_tai:  cur.sTU,
      nguoi_cuoc_xiu:  cur.bTU,
      phien_tiep_theo: String(Number(cur.phien) + 1),
      du_doan:         pred.next,
      do_tin_cay:      pred.conf + "%",
      loai_cau:        pred.cauType,
      pattern_16:      pred.pattern,
      phieu_Tai:       pred.votesT,
      phieu_Xiu:       pred.votesX,
      lich_su_count:   history.length
    }));
    return;
  }

  // ── /predict/detail ───────────────────────────────────────
  if (url.pathname === "/predict/detail") {
    await syncHistory();
    if (!history.length) {
      res.writeHead(503);
      res.end(JSON.stringify({ error:"Chưa có dữ liệu" }));
      return;
    }
    const pred = predict(history);
    res.writeHead(200);
    res.end(JSON.stringify({
      du_doan:       pred.next,
      do_tin_cay:    pred.conf + "%",
      loai_cau:      pred.cauType,
      phieu_Tai:     pred.votesT,
      phieu_Xiu:     pred.votesX,
      chi_tiet_algo: pred.detail
    }));
    return;
  }

  // ── /history ──────────────────────────────────────────────
  if (url.pathname === "/history") {
    await syncHistory();
    const lim = Math.min(parseInt(url.searchParams.get("limit") || "20"), 200);
    res.writeHead(200);
    res.end(JSON.stringify({
      total: history.length,
      data:  history.slice(0, lim).map(h => ({
        phien:    h.phien,
        tai_pct:  Math.round(h.ratio * 100) + "%",
        xiu_pct:  Math.round((1 - h.ratio) * 100) + "%",
        cuoc_tai: h.sTB,
        cuoc_xiu: h.bTB,
        ket_qua:  h.type === "T" ? "Tài" : "Xỉu"
      }))
    }));
    return;
  }

  // ── /pattern ──────────────────────────────────────────────
  if (url.pathname === "/pattern") {
    await syncHistory();
    if (!history.length) {
      res.writeHead(503);
      res.end(JSON.stringify({ error:"Chưa có dữ liệu" }));
      return;
    }
    const seq = history.map(h => h.type);
    const pat = detectPattern(seq);
    const streaks = []; let curS = { v:seq[0], len:1 };
    for (let i=1;i<Math.min(seq.length,30);i++) {
      if(seq[i]===curS.v) curS.len++;
      else { streaks.push({...curS}); curS={v:seq[i],len:1}; }
    }
    streaks.push(curS);
    res.writeHead(200);
    res.end(JSON.stringify({
      pattern_20:     seq.slice(0,20).join(""),
      cau_hien_tai:   pat ? pat.name : "Không rõ cầu",
      do_tin_cay_cau: pat ? Math.round(pat.conf*100)+"%" : "N/A",
      chuoi_gan:      streaks.slice(0,8).map(s=>({
        ket_qua:  s.v==="T"?"Tài":"Xỉu",
        so_phien: s.len
      }))
    }));
    return;
  }

  // ── /stats ────────────────────────────────────────────────
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
    res.end(JSON.stringify({ algo_stats:out, history_count:history.length, source:SOURCE_URL }));
    return;
  }

  // ── /debug ────────────────────────────────────────────────
  if (url.pathname === "/debug") {
    const r = await fetchSource().catch(e => ({ error:e.message }));
    res.writeHead(200);
    res.end(JSON.stringify(r, null, 2));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({
    error: "Not found",
    endpoints: ["/predict", "/predict/detail", "/history", "/pattern", "/stats", "/debug"]
  }));

}).listen(PORT, () => {
  console.log("✅ Sic-bo Predictor port " + PORT);
  console.log("   Source: " + SOURCE_URL);
  syncHistory();
  setInterval(syncHistory, 10000);
});
