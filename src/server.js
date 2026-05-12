const https = require("https"); 
const http = require("http"); 

const SOURCE_URL = "https://jakpotgwab.geightdors.net/glms/v1/notify/taixiu?platform_id=g8&gid=vgmn_100"; 
const PORT = process.env.PORT || 3000; 
const HISTORY_MAX = 500; 
const BOT_ID = "@sewdangcap"; 

hãy để lịch sử = []; 
let lastSid = null; 
let pendingSession = null; phiên đang cược (cmd 1008)

// ══════════════════════════════════════════════════════════════
TÌM NẠP
// ══════════════════════════════════════════════════════════════
hàm fetchSource() { 
 trả về New Promise((giải quyết, từ chối) => { 
 const req = https.get(SOURCE_URL, { 
 headers: { "User-Agent": "Mozilla/5.0", Accept: "application/json" }
 }, (res) => { 
 let raw = ""; 
 res.on("dữ liệu", c => raw += c); 
 res.on("kết thúc", () => { 
 try { resolve({ ok: true, body: JSON.parse(raw) }); }
 catch { resolve({ ok: false, raw: raw.slice(0, 800) }); }
 }); 
 }); 
 req.on("lỗi", từ chối); 
 req.setTimeout(14000, () => { req.destroy(); reject(new Error("timeout")); }); 
 }); 
}

// ══════════════════════════════════════════════════════════════
// PARSE — 2 kiểu JSON từ API: 
// 
cmd 1008 = đang cược (có sid, gi[])
// { 
status:"OK", data:[{ 
cmd: 1008, sid: 3002245, gid: "vgmn_100", 
gi:[{ B:{tU,tB}, S:{tU,tB}, aid:1 }, ...]
// }]
// }
// 
cmd 1003 = kết quả (có d1/d2/d3, KHÔNG có sid)
// { 
status:"OK", data:[{ 
cmd: 1003, gid: "vgmn_100", 
D1:5, D2:5, D3:4, 
tUB, tUS, gBB, tJpV, cBB, iJp
// }]
// }
// 
B = Tài = TÀI (tổng ≥ 11)
S = Nhỏ = XỈU (tổng ≤ 10)
// ══════════════════════════════════════════════════════════════
function parseBody(cơ thể) { 
 if (!body || body.status !== "OK") trả về null; 
 mục const = Array.isArray(body.data) ? body.data[0] : rỗng; 
 if (!entry) trả về null; 

 const cmd = Số (entry.cmd); 

 ── Kiểu 1: đang cược ──────────────────────────────────────
 nếu (cmd === 1008) { 
 const sid = String(entry.sid ?? "?"); 
 const gi0 = Mảng. isArray(entry.gi) ? entry.gi[0] : rỗng; 
 if (!gi0) trả về null; 

 const sTB = Số (gi0. B?. tB ?? 0); Tài: tổng tiền
 const sTU = Số (gi0. B?. tU ?? 0); Tài: số người
 const bTB = Số (gi0. S?. tB ?? 0); Xỉu: tổng tiền
 const bTU = Số (gi0. S?. tU ?? 0); Xỉu: số người
 const total = sTB + bTB; 
 tỷ lệ const = tổng > 0 ? sTB / tổng số: 0,5; 

 return { loại: "cá cược", sid, sTB, sTU, bTB, bTU, tổng, tỷ lệ }; 
 }

 ── Kiểu 2: kết quả xúc xắc ───────────────────────────────
 nếu (cmd === 1003) { 
 const d1 = mục nhập.d1 ?? rỗng; 
 const d2 = mục nhập.d2 ?? rỗng; 
 const d3 = mục nhập.d3 ?? rỗng; 
 if (d1 === null || d2 === null || d3 === null) trả về null; 

 const xúc xắc = { 
 d1: Số (d1), 
 d2: Số (d2), 
 d3: Số (d3), 
 Tổng: Số (d1) + Số (d2) + Số (d3)
 }; 
 return { kind: "result", xúc xắc }; 
 }

 trả về null; 
}

// ══════════════════════════════════════════════════════════════
KẾT QUẢ SUY LUẬN
// ══════════════════════════════════════════════════════════════
hàm inferType(ratio, prevType, xúc xắc) { 
 if (dice & dice.sum != null) trả về dice.sum >= 11 ? "T" : "X"; 
 nếu (tỷ lệ > 0,58) trả về "T"; 
 nếu (tỷ lệ < 0,42) trả về "X"; 
 trả về prevType ?? (tỷ lệ >= 0,5 ? "T" : "X"); 
}

// ══════════════════════════════════════════════════════════════
INGEST — xử lý 2 kiểu phân tích cú pháp
// ══════════════════════════════════════════════════════════════
function ingest(phân tích cú pháp) { 
 nếu (!parsed) trả về false; 

 ── Kiểu1: phiên cược mới / đang cược ────────────────────
 if (parsed.kind === "cá cược") {
 const { sid, sTB, sTU, bTB, bTU, tổng, tỷ lệ } = phân tích cú pháp;

if (sid === lastSid) {
 Cùng phiên → cập nhật cược (có thể thay đổi liên tục)
 if (pendingSession) Object.assign(pendingSession, { sTB, sTU, bTB, bTU, tổng, tỷ lệ });
 trả về sai;
 }

Phiên mới → chốt phiên cũ vào history
 if (pendingSession) {
 const prevType = history[0]?. loại ?? rỗng;
 pendingSession.type = inferType(pendingSession.ratio, prevType, pendingSession.dice);
 history.unshift(pendingSession);
 if (history.length > HISTORY_MAX) history = history.slice(0, HISTORY_MAX);
 if (history.length >= 2) recordActual(history[0].type);
 }

pendingSession = { phien: sid, sTB, sTU, bTB, bTU, tổng, tỷ lệ, xúc xắc: null };
 lastSid = sid;
 trả về true;
 }

── Kiểu 2: kết quả xúc xắc → gắn vào phiên đang chờ xử lý ─
 if (parsed.kind === "kết quả") {
 if (pendingSession) {
 pendingSession.dice = phân tích cú pháp.dice;
 }
 trả về sai;
 }

trả về sai;
}

// ══════════════════════════════════════════════════════════════
TRỌNG LƯỢNG TỰ HIỆU CHỈNH
// ══════════════════════════════════════════════════════════════
const ALGOS = [
 "mẫu","markov3","markov2","markov1",
 "freq","luong","streak5","entropy",
 "Chuky", "Autocorr", "Động lượng", "Bayesian",
 "ngram4","đảo chiều","chiSq","trendFollow",
 "streakLen","ratio","ratioMa","contrarian"
];
const acc = {};
for (const n của ALGOS) acc[n] = { c: 20, t: 40 };

function updateAcc(tên, pred, thực tế) {
 if (!acc[name]) trả về;
 acc[tên].t++;
 if (pred === thực tế) acc[tên].c++;
 if (acc[tên].t > 80) { acc[tên].c *= 80/acc[tên].t; acc[tên].t = 80; }
}
hàm getWeight(tên) {
 const a = acc[tên];
 if (!a || a.t < 8) trả về 1.0;
 const r = a.c / a.t;
 trả lại Math.max (0, (r - 0,38) / 0,12);
}

let lastPreds = {};
function recordActual(thực tế) {
 for (const [name, pred] của Object.entries(lastPreds)) updateAcc(name, pred, actual);
 lastPreds = {};
}

// ══════════════════════════════════════════════════════════════
PHÁT HIỆN MẪU
// ══════════════════════════════════════════════════════════════
hàm detectPattern(seq) {
 if (seq.length < 4) trả về null;
 const s = seq.join("");

const bm = s.match(/^(T{3,}|X{3,})/);
 nếu (bm) {
 const len = bm[0].chiều dài;
 const giống nhau = bm[0][0];
 const tiếp theo = len >= 7 ? (giống nhau==="T"?" X":"T"): giống nhau;
 const conf = len >= 7 ? 0,70 : Math.min(0,54 + len*0,03, 0,80);
 return { name:'Bệt ${same==="T"?" Tài":"Xỉu"}(${len})', tiếp theo, conf };
 }

let alt = 0;
 for (let i = 0; i < Math.min(seq.length, 12); i++) {
 if (i===0 || seq[i]!==seq[i-1]) alt++;
 nếu không bị vỡ;
 }
 if (alt >= 6) return { name:"Cầu 1-1 dài", next: seq[0]==="T"?" X":"T", conf:0,73 };
 if (alt >= 4) return { name:"Cầu 1-1", next: seq[0]==="T"?" X":"T", conf:0.64 };

if (s.length>=8 && s[0]===s[1] && s[2]===s[3] && s[0]!==s[2] && s[4]===s[5] && s[0]===s[4])
 return { name:"Cầu 2-2", next:s[0], conf:0.68 };
 if (s.length>=6 && s[0]!==s[1] && s[1]===s[2] && s[3]===s[4] && s[1]!==s[3])
 return { name:"Cầu 2-2 giữa", next:s[0]==="T"?" X":"T", conf:0.63 };

if (s.length>=6 && s[0]===s[1] && s[1]===s[2] && s[3]===s[4] && s[4]===s[5] && s[0]!==s[3])
 return { name:"Cầu 3-3", next:s[0], conf:0.65 };

if (s.length>=8 && s.slice(0,4).split("").every(c=>c===s[0]) && 
 s.slice(4,8).split("").every(c=>c===s[4]) && s[0]!==s[4])
 return { name:"Cầu 4-4", next:s[0], conf:0.66 }; 

 if (s.length>=6 && s[0]===s[1] && s[2]!==s[1] && s[3]===s[4] && s[5]!==s[4] && s[0]===s[3])
 return { name:"Cầu 2-1", next:s[0], conf:0.62 }; 

 if (s.length>=6 && s[0]!==s[1] && s[1]===s[2] && s[3]!==s[4] && s[4]===s[5])
 return { name:"Cầu 1-2", next:s[0], conf:0.61 }; 

 cho (const p của [2,3,4]) { 
 if (s.length >= p*3) { 
 const c = s.slice(0,p); 
 Nếu (S.Slice(P,P*2)===C && S.Slice(P*2,P*3)===C)
 return { name:'Chu Kỳ ${p}', next:c[0], conf:0.65+p*0.01 }; 
 }
 }

 if (s.length>=5 && s[0]===s[4] && s[1]===s[3] && s[1]!==s[0])
 return { name:"Cầu Gương", next:s[1]==="T"?" X":"T", conf:0.60 }; 

 trả về null; 
}

// ══════════════════════════════════════════════════════════════
THUẬT TOÁN
// ══════════════════════════════════════════════════════════════
hàm algoMarkov3(seq) { 
 if (seq.length<20) trả về null; 
 const t={}; 
 cho (giả sử i=0; i<seq.chiều dài-3; i++) { 
 const k=seq[i+3]+seq[i+2]+seq[i+1]; 
 nếu(!t[k]) t[k]={T:0,X:0}; 
 t[k][seq[i]]++; 
 }
 const k=seq[2]+seq[1]+seq[0]; const row=t[k]; if(!row) trả về null; 
 const tot = hàng. T + hàng. X; if(tot<5) trả về null; 
 if(hàng. T>hàng. X) trả về {next:"T",conf:0,50+(hàng. T/tot-0,50)*0,68}; 
 if(hàng. X>hàng. T) trả về {next:"X",conf:0,50+(hàng. X/tot-0,50)*0,68}; 
 trả về null; 
}
hàm algoMarkov2(seq) { 
 if (seq.length<15) trả về null; 
 const t={}; 
 cho (giả sử i=0; i<seq.length-2; i++) { 
 const k=seq[i+2]+seq[i+1]; 
 nếu(!t[k]) t[k]={T:0,X:0}; 
 t[k][seq[i]]++; 
 }
 const k=seq[1]+seq[0]; const row=t[k]; if(!row) trả về null; 
 const tot = hàng. T + hàng. X; if(tot<6) trả về null; 
 if(hàng. T>hàng. X) trả về {next:"T",conf:0,50+(hàng. T/tot-0,50)*0,70}; 
 if(hàng. X>hàng. T) trả về {next:"X",conf:0,50+(hàng. X/tot-0,50)*0,70}; 
 trả về null; 
}
hàm algoMarkov1(seq) { 
 if (seq.length<10) trả về null; 
 const t={T:{T:0,X:0},X:{T:0,X:0}}; 
 cho (giả sử i=0; i<seq.length-1; i++) t[seq[i+1]][seq[i]]++; 
 const hàng = t [seq [0]]; const tot = hàng. T + hàng. X; if(tot<6) trả về null; 
 if(hàng. T>hàng. X) trả về {next:"T",conf:0,50+(hàng. T/tot-0,50)*0,65}; 
 if(hàng. X>hàng. T) trả về {next:"X",conf:0,50+(hàng. X/tot-0,50)*0,65}; 
 trả về null; 
}
hàm algoFreq(seq) { 
 const n20=Math.min(seq.length,20), n50=Math.min(seq.length,50); 
 const rT=seq.slice(0,n20).filter(x=>x==="T").length/n20*0.6
 +seq.slice(0,n50).filter(x=>x==="T").length/n50*0.4; 
 const rX = 1-rT; 
 if(rT>0.60) trả về {next:"X",conf:0,50+(rT-0,50)*0,60}; 
 if(rX>0.60) trả về {next:"T",conf:0,50+(rX-0,50)*0,60}; 
 trả về null; 
}
hàm algoLuong(seq) { 
 if(seq.length<8) trả về null; 
 const w=seq.slice(0,8); để tr=0; 
 for(let i=1; i<w.length; i++) if(w[i]!==w[i-1]) tr++; 
 if(tr<=1) trả về {next:w[0],conf:0.64}; 
 if(tr>=7) trả về {next:w[0]==="T"?" X":"T",conf:0,64}; 
 trả về null; 
}
hàm algoStreak5(seq) { 
 if(seq.length<5) trả về null; 
 const f=seq[0]; 
 if(seq.slice(0,5).every(x=>x===f)) trả về {next:f==="T"?" X":"T",conf:0.67}; 
 trả về null; 
}
chức năng algoEntropy(seq) { 
 const n=Math.min(seq.length,20); const sub=seq.slice(0,n); 
 let tr=0; for(let i=1; i<sub.length; i++) if(sub[i]!==sub[i-1]) tr++; 
 const e=tr/(n-1); 
 nếu(e>0.38&&&e<0.62) trả về null;
 if(e<=0,38) trả về {next:sub[0],conf:0,61};
 return {next:sub[0]==="T"?" X":"T",conf:0,59};
}
hàm algoChuKy(seq) {
 if(seq.length<12) trả về null;
 for(let p = 2; p<=6; p++) {
 hãy để khớp = 0, tổng số = 0;
 for(let i=0; i<Math.min(seq.length-p,20); i++) {
 if(seq[i+p]!==undefined){total++; if(seq[i]===seq[i+p])match++;}
 }
 if(total>=6&&match/total>=0.75) trả về {next:seq[p-1]?? seq[0],conf:0,56+(match/total-0,75)*0,5};
 }
 trả về null;
}
chức năng algoAutoCorr(seq) {
 if(seq.length<20) trả về null;
 const n=Math.min(seq.length,40);
 const v=seq.slice(0,n).map(x=>x==="T"?1:0);
 const mean=v.reduce((a,b)=>a+b,0)/n;
 để ac1 = 0, denom = 0;
 for(let i=0; i<n; i++) denom+=(v[i]-mean)**2;
 for(let i=1; i<n; i++) ac1+=(v[i]-mean)*(v[i-1]-mean);
 ac1 / = denom;
 if(ac1>0.15) trả về {next:seq[0],conf:0.54+Math.min(ac1*0.4,0.10)};
 if(ac1<-0.15) trả về {next:seq[0]==="T"?" X":"T",conf:0.54+Math.min(-ac1*0.4,0.10)};
 trả về null;
}
hàm algoMomentum(seq) {
 if(seq.length<30) trả về null;
 const s=seq.slice(0,5).filter(x=>x==="T").length/5;
 const l=seq.slice(0,20).filter(x=>x==="T").length/20;
 const d=sl;
 if(d>0.25) trả về {next:"T",conf:0.55+Math.min(d*0.3,0.08)};
 if(d<-0.25) trả về {next:"X",conf:0.55+Math.min(-d*0.3,0.08)};
 trả về null;
}
hàm algoBayesian(seq) {
 if(seq.length<15) trả về null;
 let logOdds=0;
 for(const w của [3,5,8,13]) {
 const sub=seq.slice(0,Math.min(w,seq.length));
 const pT=(sub.filter(x=>x==="T").length+1)/(sub.length+2);
 logOdds+=Math.log (pT / (1-pT)) / 4;
 }
 const pT = 1 / (1 + Math.exp (-logOdds));
 if(pT>0,58) trả về {next:"T",conf:0,50+(pT-0,50)*0,8};
 if(pT<0,42) trả về {next:"X",conf:0,50+(0,50-pT)*0,8};
 trả về null;
}
hàm algoNgram4(seq) {
 if(seq.length<25) trả về null;
 const t={};
 for(let i=0; i<seq.length-4; i++){
 const k=seq[i+4]+seq[i+3]+seq[i+2]+seq[i+1];
 nếu(!t[k]) t[k]={T:0,X:0};
 t[k][seq[i]]++;
 }
 const k=seq[3]+seq[2]+seq[1]+seq[0]; const hàng = t [k]; if(!row) trả về null;
 const tot=hàng. T + hàng. X; if(tot<4) trả về null;
 if(hàng. > hàng. X) trả về {next:"T",conf:0,50+(hàng. T/tot-0,50)*0,72};
 if(hàng. X>row. T) trả về {next:"X",conf:0,50+(hàng. X/tot-0,50)*0,72};
 trả về null;
}
hàm algoReversal(seq) {
 if(seq.length<20) trả về null;
 để sLen=1; trong khi(sLen<seq.length&&seq[sLen]===seq[0]) sLen++;
 if(sLen<2) trả về null;
 để rev=0,samp=0;
 for(let i=sLen; i<seq.length-sLen; i++){
 if(seq.slice(i,i+sLen).every(x=>x===seq[i])){
 samp++; if(seq[i-1]!==seq[i]) rev++; i+=sLen-1;
 }
 }
 if(samp<3) trả về null;
 const pr=rev/samp;
 if(pr>0.65) trả về {next:seq[0]==="T"?" X":"T",conf:0,52+pr*0,10};
 if(pr<0.35) trả về {next:seq[0],conf:0,52+(1-pr)*0,10};
 trả về null;
}
hàm algoChiSq(seq) {
 if(seq.length<30) trả về null;
 const obs={TT:0,TX:0,XT:0,XX:0};
 for(let i=0; i<seq.length-1; i++){const k=seq[i+1]+seq[i]; if(obs[k]!==undefined)obs[k]++;}
 const n=Object.values(obs).reduce((a,b)=>a+b,0);
 const exp=n/4;
 const chi2=Object.values(obs).reduce((s,o)=>s+(o-exp)**2/exp,0);
 if(chi2<3.84) trả về null;
 const pTT=obs.TT/(obs.TT+obs. TX + 0,001);
 const pXX=obs. XX/(obs. XX + obs. XT+0,001);
 if(seq[0]==="T"&&pTT>0.60) trả về {next:"T",conf:0.52+pTT*0.10};
 if(seq[0]==="T"&&pTT<0.40) trả về {next:"X",conf:0.52+(1-pTT)*0.10};
 if(seq[0]==="X"&&pXX>0.60) trả về {next:"X",conf:0,52+pXX*0,10};
 if(seq[0]==="X"&&pXX<0.40) trả về {next:"T",conf:0.52+(1-pXX)*0.10};
 trả về null;
}
hàm algoTrendFollow(seq) {
 if(seq.length<12) trả về null;
 const v=seq.slice(0,20).map(x=>x==="T"?1:0);
 const ema=(arr,a)=>arr.reduce((e,x,i)=>i===0?x:a*x+(1-a)*e,arr[0]);
 const e5=ema(v.slice(0,5),0,4), e12=ema(v.slice(0,12),0,2);
 if(e5>e12+0.08) trả về {next:"T",conf:0.55};
 if(e5<e12-0.08) trả về {next:"X",conf:0.55};
 trả về null;
}
hàm algoStreakLen(seq) {
 if(seq.length<20) trả về null;
 const streaks=[]; hãy để cur=1;
 for(let i=1; i<seq.length; i++){
 if(seq[i]===seq[i-1])cur++;
 else{streaks.push(cur); cur=1;}
 }
 vệt.push(cur);
 if(streaks.length<4) trả về null;
 const avgLen=streaks.reduce((a,b)=>a+b,0)/streaks.length;
 hãy để curLen=1; while(curLen<seq.length&&seq[curLen]===seq[0]) curLen++;
 if(curLen>=Math.ceil(avgLen*1.5)) trả về {next:seq[0]==="T"?" X":"T",conf:0.57};
 if(curLen===1&&curLen<avgLen*0.6) trả về {next:seq[0],conf:0.54};
 trả về null;
}
hàm algoRatio(hist) {
 if(!hist.length) trả về null;
 const r=hist[0].tỷ lệ;
 if(r>0.62) trả về {next:"T",conf:0,50+(r-0,50)*0,55};
 if(r<0.38) trả về {next:"X",conf:0,50+(0,50-r)*0,55};
 trả về null;
}
hàm algoRatioMa(hist) {
 if(hist.length<5) trả về null;
 const ma=hist.slice(0,5).reduce((s,h)=>s+h.ratio,0)/5;
 if(ma>0,60) trả về {next:"T",conf:0,52+(ma-0,50)*0,40};
 if(ma<0,40) trả về {next:"X",conf:0,52+(0,50-ma)*0,40};
 trả về null;
}
hàm algoContrarian(hist) {
 if(hist.length<10) trả về null;
 const avgTotal=hist.slice(1,11).reduce((s,h)=>s+(h.total||0),0)/10;
 const cur=hist[0];
 if((cur.total||0) tổng < trung bình*0,5) trả về giá trị rỗng;
 const r = cur.ratio;
 if(r>0,65) trả về {next:"T",conf:0,58+(r-0,65)*0,40};
 if(r<0.35) trả về {next:"X",conf:0,58+(0,35-r)*0,40};
 trả về null;
}

// ══════════════════════════════════════════════════════════════
QUẦN THỂ
// ══════════════════════════════════════════════════════════════
function predict(hist) {
 if (hist.length < 3) trả về {
 next:"?", conf:0, cauType:"Chưa đủ dữ liệu",
 phiếu T:0, phiếu X:0, chi tiết:{}
 };

const seq = hist.map(h => h.type);
 const wSum = { T:0, X:0 };
 chi tiết const = {}, phiếu bầu = [];

const add = (tên, res, base) => {
 if (!res) { detail[name] = null; return; }
 lastPreds[tên] = res.next;
 const w = cơ sở * getWeight(tên);
 wSum[res.next] += res.conf * w;
 detail[name] = { next:res.next, conf:Math.round(res.conf*100), w:Math.round(w*100)/100 };
 votes.push({ thuật ngữ:tên, pred:res.next });
 };

const pat = detectPattern(seq);
 add("mẫu", pat, 5.0);
 add("contrarian", algoContrarian(hist), 4.0);
 add("ratio", algoRatio(hist), 3,5);
 add("ratioMa", algoRatioMa(hist), 2,5);
 add("markov3", algoMarkov3(seq), 3.5);
 add("markov2", algoMarkov2(seq), 3.0);
 add("markov1", algoMarkov1(seq), 2.5);
 add("ngram4", algoNgram4(seq), 2.5);
 add("Bayesian", algoBayesian(seq), 2.0);
 add("streak5", algoStreak5(seq), 2.0);
 add("autocorr", algoAutoCorr(seq), 1.8);
 add("chiSq", algoChiSq(seq), 1.8);
 add("luong", algoLuong(seq), 1.5);
 add("động lượng", algoMomentum(seq), 1.5);
 add("freq", algoFreq(seq), 1.5);
 add("trendFollow", algoTrendFollow(seq), 1.2);
 add("chuky", algoChuKy(seq), 1.2);
 add("entropy", algoEntropy(seq), 1.0);
 add("đảo ngược", algoReversal(seq), 1.0);
 add("streakLen", algoStreakLen (tiếp theo), 1.0);

const tot = wSum.T + wSum.X;
 let next = "T", conf = 0,50;
 if (tot > 0) {
 if (wSum.X > wSum.T) { next = "X"; conf = wSum.X / tot; }
 else { next = "T"; conf = wSum.T / tot; }
 }
 conf = Math.min(Math.max(conf, 0,50), 0,90);

const cauType = pat ? pat.name
 : wSum.T > wSum.X ? "Nghiêng Tài"
 : wSum.X > wSum.T ? "Nghiêng Xỉu"
 : "Cân bằng";

trả về {
 tiếp theo,
 conf: Math.round(conf * 100),
 cauType,
 votesT: votes.filter(v => v.pred === "T").length,
 votesX: votes.filter(v => v.pred === "X").length,
 chi tiết
 };
}

// ══════════════════════════════════════════════════════════════
ĐỒNG BỘ
// ══════════════════════════════════════════════════════════════
chức năng không đồng bộ syncHistory() {
 thử {
 const res = chờ fetchSource();
 nếu (!res.ok || !res.body) trở về;
 const parsed = parseBody(res.body);
 nhập (phân tích cú pháp);
 } bắt (_) {}
}

// ══════════════════════════════════════════════════════════════
MÁY CHỦ HTTP
// ══════════════════════════════════════════════════════════════
http.createServer(async (req, res) => {
 res.setHeader("Loại nội dung", "ứng dụng/json; charset=utf-8");
 res.setHeader("Access-Control-Allow-Origin", "*");
 if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

const url = URL mới (req.url, "http://localhost");

── /dự đoán ───────────────────────────────────────────────
 if (url.pathname === "/dự đoán" || url.pathname === "/") {
 chờ syncHistory();

Phiên đã có kết quả: lấy từ history[0]
 Phiên đang cược: lấy từ pendingSession
 const lastLocked = history[0] ?? rỗng;
 const cur = pendingSession ?? khóa cuối cùng;

nếu (!cur) {
 res.writeHead(503);
 res.end(JSON.stringify({ error: "Chưa có dữ liệu" }));
 trở về;
 }

Kết quả phiên vừa kết thúc
 const ketQua = khóa cuối cùng
 ? (lastLocked.type === "T" ? "Tài" : "Xỉu")
 : rỗng;

Xúc xắc dạng mảng [d1, d2, d3] hoặc null
 const xucXac = lastLocked?. xúc xắc
 ? [lastLocked.dice.d1, lastLocked.dice.d2, lastLocked.dice.d3]
 : rỗng;

Phiên hiện tại = phiên đã kết thúc (lastLocked)
 Phiên dự đoán = phiên đang cược (pendingSession)
 const phienHienTai = Number(lastLocked?. Phiên ?? cur.phien);
 const phienDuDoan = pendingSession
 ? Số (pendingSession.phien)
 : PhienHienTai + 1;

const pred = dự đoán (lịch sử);

Mẫu: chuỗi kết quả gần nhất dạng chữ thường (t/x)
 Const Pattern = Lịch sử
 .lát (0, 30)
 .map(h => h.type === "T" ? "T": "X")
 .join("");

res.writeHead(200);
 res.end(JSON.stringify({
 phien_hien_tai: phienHienTai,
 ket_qua: ketQua,
 xuc_xac: xucXac,
 phien_du_doan: phienDuDoan,
 du_doan: pred.next === "T" ? "Tài" : "Xỉu",
 do_tin_cay: pred.conf + "%",
 mẫu,
 Mã số: BOT_ID
 }));
 trở về;
 }

── /lịch sử ──────────────────────────────────────────────
 if (url.pathname === "/history") {
 chờ syncHistory();
 const lim = Math.min(parseInt(url.searchParams.get("giới hạn") || "20"), 200);
 res.writeHead(200);
 res.end(JSON.stringify({
 Tổng: history.length,
 Dữ liệu: history.slice(0, lim).map(h => ({
 Phiên: H.Phien,
 tai_pct: Math.round (tỷ lệ h * 100) + "%",
 xiu_pct: Math.round((1 - h.ratio) * 100) + "%",
 cuoc_tai: h.sTB,
 cuoc_xiu: h.bTB,
 nguoi_tai: h.sTU,
 nguoi_xiu: h.bTU,
 xuc_xac: H.dice ? [h.dice.d1, h.dice.d2, h.dice.d3] : rỗng,
 ket_qua: h.type === "T" ? "Tài" : "Xỉu"
 }))
 }));
 trở về;
 }

── /mẫu ──────────────────────────────────────────────
 if (url.pathname === "/pattern") {
 chờ syncHistory();
 nếu (!history.length) {
 res.writeHead(503);
 res.end(JSON.stringify({ error: "Chưa có dữ liệu" }));
 trở về;
 }
 const seq = history.map(h => h.type);
 const pat = detectPattern(seq);
 vệt const = []; let curS = { v:seq[0], len:1 };
 for (giả sử i=1; i<Math.min(seq.length, 30); i++) {
 if(seq[i]===curS.v) curS.len++;
 else { streaks.push({... curS}); curS={v:seq[i],len:1}; }
 }
 streaks.push(curS);
 res.writeHead(200);
 res.end(JSON.stringify({
 pattern_20: seq.slice(0,20).map(x=>x==="T"?" t":"x").join(""),
 cau_hien_tai: vỗ ? pat.name : "Không rõ cầu",
 do_tin_cay_cau: vỗ ? Math.round(pat.conf*100)+"%": "N/A",
 chuoi_gan: streaks.slice(0,8).map(s=>({
 ket_qua: s.v==="T"?" Tài":"Xỉu",
 so_phien: s.len
 }))
 }));
 trở về;
 }

── /chỉ số ────────────────────────────────────────────────
 if (url.pathname === "/stats") {
 const out = {};
 for (const n của ALGOS) {
 const a = acc[n];
 ra[n] = {
 do_chinh_xac: A.T ? Math.round(ac/a.t*100)+"%": "N/A",
 trong_so: Math.round (getWeight (n) * 100) / 100,
 mau: Math.round(a.t)
 };
 }
 res.writeHead(200);
 res.end(JSON.stringify({ algo_stats:out, history_count:history.length, nguồn:SOURCE_URL }));
 trở về;
 }

── /──────────────────────────────────────────────── gỡ lỗi
 if (url.pathname === "/debug") {
 const r = await fetchSource().catch(e => ({ error:e.message }));
 res.writeHead(200);
 res.end(JSON.stringify({
 raw_api: r,
 pending_session: pendingSession,
 last_locked: lịch sử[0] ?? rỗng,
 history_count: history.length
 }, rỗng, 2));
 trở về;
 }

res.writeHead(404);
 res.end(JSON.stringify({
 error: "Không tìm thấy",
 điểm cuối: ["/predict", "/history", "/pattern", "/stats", "/debug"]
 }));

}).listen(CỔNG, () => {
 console.log("✅ Cổng dự đoán Sic-bo" + PORT);
 console.log(" Nguồn: " + SOURCE_URL);
 syncHistory();
 setInterval(syncHistory, 10000);
});
