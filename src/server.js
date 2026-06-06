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
    const dice = {
      d1: Number(d1), d2: Number(d2), d3: Number(d3),
      sum: Number(d1) + Number(d2) + Number(d3)
    };
    return { kind: "result", dice };
  }
  return null;
}

// ══════════════════════════════════════════════════════════════
// SUY LUẬN KẾT QUẢ
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
// HỆ THỐNG DỰ ĐOÁN
// ══════════════════════════════════════════════════════════════
function analyzeSumChart(hist) {
  const sums = hist.map(h => h.dice?.sum ?? null).filter(x => x !== null);
  if (sums.length < 4) return null;

  const recent4 = sums.slice(0, 4);
  const older4  = sums.slice(4, 8);

  let trend = 0;
  for (let i = 1; i < Math.min(sums.length, 6); i++) {
    if (sums[i-1] > sums[i]) trend++;
    else if (sums[i-1] < sums[i]) trend--;
  }

  const avgRecent = recent4.reduce((a, b) => a + b, 0) / recent4.length;
  const avgOlder  = older4.length ? older4.reduce((a, b) => a + b, 0) / older4.length : avgRecent;
  const isPeak    = sums[0] > sums[1] && sums[0] > sums[2];
  const isTrough  = sums[0] < sums[1] && sums[0] < sums[2];
  const max4 = Math.max(...recent4);
  const min4 = Math.min(...recent4);
  const range = max4 - min4;

  let next = null, conf = 0.52, reason = "";

  if (isPeak && sums[0] >= 14) {
    next = "X"; conf = 0.60 + Math.min((sums[0] - 14) * 0.02, 0.10);
    reason = `Đỉnh cao (${sums[0]}) → Xỉu`;
  } else if (isTrough && sums[0] <= 7) {
    next = "T"; conf = 0.60 + Math.min((7 - sums[0]) * 0.02, 0.10);
    reason = `Đáy thấp (${sums[0]}) → Tài`;
  } else if (trend >= 3 && avgRecent > 11) {
    next = "T"; conf = 0.57;
    reason = "Xu hướng tổng tăng";
  } else if (trend <= -3 && avgRecent < 11) {
    next = "X"; conf = 0.57;
    reason = "Xu hướng tổng giảm";
  } else if (range >= 8) {
    const mid = (max4 + min4) / 2;
    next = sums[0] > mid ? "X" : "T";
    conf = 0.55;
    reason = "Mean reversion";
  } else if (avgRecent > avgOlder + 1.5) {
    next = "T"; conf = 0.55;
    reason = "Tổng trung bình tăng";
  } else if (avgRecent < avgOlder - 1.5) {
    next = "X"; conf = 0.55;
    reason = "Tổng trung bình giảm";
  }

  return next ? { next, conf, reason } : null;
}

function analyzeDiceChart(hist) {
  const diceHist = hist.filter(h => h.dice).slice(0, 15);
  if (diceHist.length < 5) return null;

  const d1s = diceHist.map(h => h.dice.d1);
  const d2s = diceHist.map(h => h.dice.d2);
  const d3s = diceHist.map(h => h.dice.d3);

  function diceAvg(arr, n) {
    return arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  }

  const avg1_3 = diceAvg(d1s, 3), avg1_6 = diceAvg(d1s, 6);
  const avg2_3 = diceAvg(d2s, 3), avg2_6 = diceAvg(d2s, 6);
  const avg3_3 = diceAvg(d3s, 3), avg3_6 = diceAvg(d3s, 6);

  const mom1 = avg1_3 - avg1_6;
  const mom2 = avg2_3 - avg2_6;
  const mom3 = avg3_3 - avg3_6;
  const totalMom = mom1 + mom2 + mom3;

  const predictedAvgPerDice = 3.5 + totalMom * 0.3;
  const predictedSum = predictedAvgPerDice * 3;

  function isAlternating(arr, n) {
    let alt = 0;
    for (let i = 1; i < Math.min(arr.length, n); i++) {
      if ((arr[i-1] > 3.5) !== (arr[i] > 3.5)) alt++;
      else break;
    }
    return alt >= n - 2;
  }

  const altCount = [isAlternating(d1s, 5), isAlternating(d2s, 5), isAlternating(d3s, 5)].filter(Boolean).length;

  let next = null, conf = 0.52, reason = "";

  if (altCount >= 2) {
    const lastSum = diceHist[0].dice.sum;
    next = lastSum >= 11 ? "X" : "T";
    conf = 0.58 + altCount * 0.03;
    reason = `${altCount} xúc xắc xen kẽ`;
  } else if (Math.abs(totalMom) > 0.5) {
    next = predictedSum >= 11 ? "T" : "X";
    conf = 0.54 + Math.min(Math.abs(totalMom) * 0.04, 0.10);
    reason = `Momentum xúc xắc (${totalMom > 0 ? "+" : ""}${totalMom.toFixed(1)})`;
  }

  return next ? { next, conf, reason } : null;
}

function analyzePattern(hist) {
  if (hist.length < 4) return null;
  const seq = hist.map(h => h.type);
  const s   = seq.join("");

  const betLen = (() => {
    let l = 1;
    while (l < seq.length && seq[l] === seq[0]) l++;
    return l;
  })();

  if (betLen >= 5) return { next: seq[0] === "T" ? "X" : "T", conf: 0.65, reason: `Bệt ${betLen}, dự phá` };
  if (betLen >= 3) return { next: seq[0], conf: 0.58, reason: `Bệt ${betLen}, tiếp tục` };

  let alt = 1;
  for (let i = 1; i < Math.min(seq.length, 12); i++) {
    if (seq[i] !== seq[i-1]) alt++;
    else break;
  }
  if (alt >= 6) return { next: seq[0] === "T" ? "X" : "T", conf: 0.72, reason: `Cầu 1-1 (${alt})` };
  if (alt >= 4) return { next: seq[0] === "T" ? "X" : "T", conf: 0.63, reason: `Cầu 1-1 (${alt})` };

  if (s.length >= 8 && s[0]===s[1] && s[2]===s[3] && s[0]!==s[2] && s[4]===s[5] && s[0]===s[4])
    return { next: s[0], conf: 0.66, reason: "Cầu 2-2" };

  if (s.length >= 6 && s[0]===s[1] && s[1]===s[2] && s[3]===s[4] && s[4]===s[5] && s[0]!==s[3])
    return { next: s[0], conf: 0.64, reason: "Cầu 3-3" };

  for (const p of [2, 3, 4]) {
    if (s.length >= p * 3) {
      const c = s.slice(0, p);
      if (s.slice(p, p*2) === c && s.slice(p*2, p*3) === c)
        return { next: c[0], conf: 0.63, reason: `Chu kỳ ${p}` };
    }
  }

  return null;
}

function analyzeBetting(hist) {
  const r = pendingSession?.ratio ?? hist[0]?.ratio ?? 0.5;
  if (r > 0.68) return { next: "T", conf: 0.58, reason: `Crowd Tài ${Math.round(r*100)}%` };
  if (r < 0.32) return { next: "X", conf: 0.58, reason: `Crowd Xỉu ${Math.round((1-r)*100)}%` };
  if (r > 0.60) return { next: "T", conf: 0.54, reason: `Crowd nhẹ Tài ${Math.round(r*100)}%` };
  if (r < 0.40) return { next: "X", conf: 0.54, reason: `Crowd nhẹ Xỉu ${Math.round((1-r)*100)}%` };
  return { next: r >= 0.5 ? "T" : "X", conf: 0.51, reason: `Cân bằng Tài ${Math.round(r*100)}% / Xỉu ${Math.round((1-r)*100)}%` };
}

function predict(hist) {
  if (hist.length < 1) {
    const ps = pendingSession;
    if (ps) {
      const r = ps.ratio ?? 0.5;
      const next = r >= 0.5 ? "T" : "X";
      const conf = Math.round((0.50 + Math.abs(r - 0.5) * 0.6) * 100);
      const reason = `Tỷ lệ cược: Tài ${Math.round(r*100)}% / Xỉu ${Math.round((1-r)*100)}%`;
      return { next, conf, reason, detail: { sumChart: null, diceChart: null, pattern: null, betting: { next, conf, reason } } };
    }
    return { next: "T", conf: 52, reason: "Khởi động...", detail: { sumChart: null, diceChart: null, pattern: null, betting: null } };
  }

  if (hist.length < 3) {
    const bettingRes = analyzeBetting(hist);
    const ps = pendingSession;
    let bettingFinal = bettingRes;
    if (ps) {
      const r = ps.ratio ?? 0.5;
      if (r > 0.60) bettingFinal = { next: "T", conf: 0.53 + (r-0.60)*0.3, reason: `Crowd Tài ${Math.round(r*100)}%` };
      else if (r < 0.40) bettingFinal = { next: "X", conf: 0.53 + (0.40-r)*0.3, reason: `Crowd Xỉu ${Math.round((1-r)*100)}%` };
    }
    const next = bettingFinal?.next ?? (hist[0]?.type ?? "T");
    const conf = bettingFinal ? Math.round(bettingFinal.conf * 100) : 52;
    const reason = bettingFinal?.reason ?? `Ít dữ liệu — theo ${next === "T" ? "Tài" : "Xỉu"}`;
    return { next, conf, reason, detail: { sumChart: null, diceChart: null, pattern: null, betting: { next, conf, reason } } };
  }

  const sumChartResult  = analyzeSumChart(hist);
  const diceChartResult = analyzeDiceChart(hist);
  const patternResult   = analyzePattern(hist);
  const bettingResult   = analyzeBetting(hist);

  const sources = [
    { w: 3.0, r: sumChartResult  },
    { w: 2.5, r: diceChartResult },
    { w: 2.0, r: patternResult   },
    { w: 1.5, r: bettingResult   },
  ];

  const wSum = { T: 0, X: 0 };
  for (const { w, r } of sources) {
    if (!r) continue;
    wSum[r.next] += r.conf * w;
  }

  const tot = wSum.T + wSum.X;
  let next = "T", conf = 0.50;
  if (tot > 0) {
    if (wSum.X > wSum.T) { next = "X"; conf = wSum.X / tot; }
    else                 { next = "T"; conf = wSum.T / tot; }
  }
  conf = Math.min(Math.max(conf, 0.50), 0.88);

  const reason = patternResult?.reason ?? sumChartResult?.reason ?? diceChartResult?.reason ?? bettingResult?.reason ?? (next === "T" ? "Nghiêng Tài" : "Nghiêng Xỉu");

  return {
    next, conf: Math.round(conf * 100), reason,
    detail: {
      sumChart:  sumChartResult  ? { next: sumChartResult.next,  conf: Math.round(sumChartResult.conf * 100),  reason: sumChartResult.reason  } : null,
      diceChart: diceChartResult ? { next: diceChartResult.next, conf: Math.round(diceChartResult.conf * 100), reason: diceChartResult.reason } : null,
      pattern:   patternResult   ? { next: patternResult.next,   conf: Math.round(patternResult.conf * 100),   reason: patternResult.reason   } : null,
      betting:   bettingResult   ? { next: bettingResult.next,   conf: Math.round(bettingResult.conf * 100),   reason: bettingResult.reason   } : null,
    }
  };
}

// ══════════════════════════════════════════════════════════════
// FAKE DICE CHO DỰ ĐOÁN
// ══════════════════════════════════════════════════════════════
function generateFakeDiceForPrediction(pred, hist) {
  const histWithDice = hist.filter(h => h.dice).slice(0, 10);
  if (!histWithDice.length) {
    if (pred.next === "T") {
      const sum = 11 + Math.floor(Math.random() * 7);
      const d1 = Math.min(6, Math.ceil(sum / 3));
      const d2 = Math.min(6, Math.ceil((sum - d1) / 2));
      const d3 = Math.max(1, sum - d1 - d2);
      return { d1, d2, d3, sum: d1+d2+d3, fake: true };
    } else {
      const sum = 4 + Math.floor(Math.random() * 7);
      const d1 = Math.min(6, Math.ceil(sum / 3));
      const d2 = Math.min(6, Math.ceil((sum - d1) / 2));
      const d3 = Math.max(1, sum - d1 - d2);
      return { d1, d2, d3, sum: d1+d2+d3, fake: true };
    }
  }

  const recentD1 = histWithDice.slice(0, 4).map(h => h.dice.d1);
  const recentD2 = histWithDice.slice(0, 4).map(h => h.dice.d2);
  const recentD3 = histWithDice.slice(0, 4).map(h => h.dice.d3);

  const avgD1 = recentD1.reduce((a,b)=>a+b,0)/recentD1.length;
  const avgD2 = recentD2.reduce((a,b)=>a+b,0)/recentD2.length;
  const avgD3 = recentD3.reduce((a,b)=>a+b,0)/recentD3.length;
  const trendD1 = recentD1[0] - recentD1[recentD1.length-1];
  const trendD2 = recentD2[0] - recentD2[recentD2.length-1];
  const trendD3 = recentD3[0] - recentD3[recentD3.length-1];

  const clamp = v => Math.min(6, Math.max(1, Math.round(v)));
  let pd1 = clamp(avgD1 + trendD1*0.3 + (Math.random()-0.5)*1.5);
  let pd2 = clamp(avgD2 + trendD2*0.3 + (Math.random()-0.5)*1.5);
  let pd3 = clamp(avgD3 + trendD3*0.3 + (Math.random()-0.5)*1.5);
  let psum = pd1 + pd2 + pd3;

  if (pred.next === "T" && psum < 11) {
    const diff = 11 - psum;
    pd1 = clamp(pd1 + Math.ceil(diff/3));
    pd2 = clamp(pd2 + Math.ceil(diff/3));
    pd3 = clamp(pd3 + Math.floor(diff/3));
    psum = pd1+pd2+pd3;
    if (psum < 11) pd1 = Math.min(6, pd1+(11-psum));
  } else if (pred.next === "X" && psum >= 11) {
    const diff = psum - 10;
    pd1 = clamp(pd1 - Math.ceil(diff/3));
    pd2 = clamp(pd2 - Math.ceil(diff/3));
    pd3 = clamp(pd3 - Math.floor(diff/3));
    psum = pd1+pd2+pd3;
    if (psum >= 11) pd1 = Math.max(1, pd1-(psum-10));
  }

  return { d1: pd1, d2: pd2, d3: pd3, sum: pd1+pd2+pd3, fake: true };
}

// ══════════════════════════════════════════════════════════════
// RENDER BIỂU ĐỒ — sát với giao diện game thật
// ══════════════════════════════════════════════════════════════
function renderChartHTML(hist, pred, fakeDice) {
  const displayHist = hist.filter(h => h.dice).slice(0, 19);
  displayHist.reverse(); // cũ → mới (trái → phải)

  const predPhien = displayHist.length
    ? String(Number(displayHist[displayHist.length - 1].phien) + 1)
    : "???";

  const allPoints = [
    ...displayHist.map(h => ({
      phien: h.phien, sum: h.dice.sum,
      d1: h.dice.d1, d2: h.dice.d2, d3: h.dice.d3,
      type: h.type, fake: false
    })),
    {
      phien: predPhien, sum: fakeDice.sum,
      d1: fakeDice.d1, d2: fakeDice.d2, d3: fakeDice.d3,
      type: pred.next, fake: true
    }
  ];

  const n = allPoints.length;
  if (n < 2) return "";

  // ── Kích thước canvas — tỷ lệ giống game thật ─────────────
  const W   = 1080;
  const PL  = 48, PR = 16;
  const PT  = 20, PB = 20;

  // Vùng trên (tổng): ~40% tổng chiều cao chart
  const H_TOP = 200;
  // Gap giữa 2 chart
  const GAP   = 24;
  // Vùng dưới (xúc xắc): ~55% — lớn hơn, giống game
  const H_BOT = 260;
  // Nhãn trục X
  const X_LBL = 22;

  const TOTAL = H_TOP + GAP + H_BOT + X_LBL;
  const chartW = W - PL - PR;
  const colW   = n > 1 ? chartW / (n - 1) : chartW;
  const xs     = allPoints.map((_, i) => PL + i * colW);

  // ── Hàm Y ─────────────────────────────────────────────────
  // Trục tổng: 3–18, giá trị cao = lên trên
  const sumMin = 3, sumMax = 18;
  function sumY(v) {
    const ratio = (v - sumMin) / (sumMax - sumMin);
    return PT + (H_TOP - PT - PB) * (1 - ratio);
  }

  // Trục xúc xắc: 1–6
  const botBase = H_TOP + GAP;
  function diceY(v) {
    const ratio = (v - 1) / 5;
    return botBase + PT + (H_BOT - PT - PB) * (1 - ratio);
  }

  // ── Grid ngang trên ─────────────────────────────────────
  const sumTicks = [3, 6, 9, 12, 15, 18];
  let gridHTop = "", labelsTop = "";
  for (const v of sumTicks) {
    const y = sumY(v);
    const isMiddle = v === 12;
    gridHTop += `<line x1="${PL}" y1="${y}" x2="${W-PR}" y2="${y}"
      stroke="${isMiddle ? 'rgba(220,170,60,0.55)' : 'rgba(200,150,40,0.28)'}"
      stroke-width="${isMiddle ? 1.5 : 1}"/>`;
    labelsTop += `<text x="${PL-6}" y="${y+4}" fill="#C8A84B" font-size="11"
      text-anchor="end" font-family="Arial,sans-serif" font-weight="700">${v}</text>`;
  }

  // ── Grid ngang dưới ──────────────────────────────────────
  const diceTicks = [1, 2, 3, 4, 5, 6];
  let gridHBot = "", labelsBot = "";
  for (const v of diceTicks) {
    const y = diceY(v);
    gridHBot += `<line x1="${PL}" y1="${y}" x2="${W-PR}" y2="${y}"
      stroke="rgba(200,150,40,0.28)" stroke-width="1"/>`;
    labelsBot += `<text x="${PL-6}" y="${y+4}" fill="#C8A84B" font-size="11"
      text-anchor="end" font-family="Arial,sans-serif" font-weight="700">${v}</text>`;
  }

  // ── Grid dọc ────────────────────────────────────────────
  let gridV = "";
  for (let i = 0; i < n; i++) {
    gridV += `<line x1="${xs[i].toFixed(1)}" y1="${PT}" x2="${xs[i].toFixed(1)}" y2="${H_TOP-PB}"
      stroke="rgba(200,150,40,0.20)" stroke-width="1"/>`;
    gridV += `<line x1="${xs[i].toFixed(1)}" y1="${botBase+PT}" x2="${xs[i].toFixed(1)}" y2="${botBase+H_BOT-PB}"
      stroke="rgba(200,150,40,0.20)" stroke-width="1"/>`;
  }

  // ── Đường & dot tổng (vàng) ──────────────────────────────
  const sumPolyPts = allPoints.map((p,i) => `${xs[i].toFixed(1)},${sumY(p.sum).toFixed(1)}`).join(" ");
  const sumLine = `<polyline points="${sumPolyPts}" fill="none" stroke="#E8C020"
    stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;

  let sumDots = "";
  for (let i = 0; i < n; i++) {
    const p   = allPoints[i];
    const cx  = xs[i].toFixed(1);
    const cy  = sumY(p.sum).toFixed(1);
    const isFake = p.fake;
    const isT    = p.sum >= 11;

    if (isFake) {
      // Điểm dự đoán: viền cam nổi bật, nền cam đậm
      sumDots += `
        <circle cx="${cx}" cy="${cy}" r="20" fill="#FF4400" stroke="#FF7700" stroke-width="3"/>
        <circle cx="${cx}" cy="${cy}" r="16" fill="#FF5500" stroke="none"/>
        <text x="${cx}" y="${parseFloat(cy)+5}" fill="#fff" font-size="13"
          text-anchor="middle" font-family="Arial Black,Arial" font-weight="900">${p.sum}</text>
        <text x="${cx}" y="${parseFloat(cy)+33}" fill="#FF6600" font-size="10"
          text-anchor="middle" font-family="Arial,sans-serif" font-weight="700">DỰ</text>`;
    } else {
      // Dot thật: vàng (Tài) / xám (Xỉu), kích thước nhỏ gọn như game
      const fill   = isT ? "#E8C020" : "#808080";
      const stroke = isT ? "#9A7800" : "#404040";
      const tc     = isT ? "#1a0d00" : "#ffffff";
      sumDots += `
        <circle cx="${cx}" cy="${cy}" r="15" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
        <text x="${cx}" y="${parseFloat(cy)+5}" fill="${tc}" font-size="12"
          text-anchor="middle" font-family="Arial Black,Arial" font-weight="900">${p.sum}</text>`;
    }
  }

  // ── 3 đường xúc xắc — màu giống game thật ────────────────
  // Game thật: Tím (#CC44FF) / Đỏ (#FF3333) / Xanh lá (#00CC55)
  const DICE_COLORS = ["#CC44FF", "#FF3333", "#00CC55"];
  const DICE_GLOW   = ["rgba(180,0,255,0.35)", "rgba(255,0,0,0.35)", "rgba(0,200,80,0.35)"];

  let diceLines = "", diceDots = "";

  for (let d = 0; d < 3; d++) {
    const key = d === 0 ? "d1" : d === 1 ? "d2" : "d3";
    const col = DICE_COLORS[d];
    const glow = DICE_GLOW[d];

    // Đường nối
    const pts = allPoints.map((p,i) => `${xs[i].toFixed(1)},${diceY(p[key]).toFixed(1)}`).join(" ");
    diceLines += `<polyline points="${pts}" fill="none" stroke="${col}"
      stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" opacity="0.95"/>`;

    // Dots
    for (let i = 0; i < n; i++) {
      const p  = allPoints[i];
      const cx = xs[i].toFixed(1);
      const cy = diceY(p[key]).toFixed(1);
      const r  = p.fake ? 11 : 10;

      // Outer glow
      diceDots += `<circle cx="${cx}" cy="${cy}" r="${r+5}" fill="${glow}"/>`;
      // Main dot
      diceDots += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${col}" stroke="#111" stroke-width="2"/>`;
      // Highlight
      diceDots += `<circle cx="${parseFloat(cx)-r*0.25}" cy="${parseFloat(cy)-r*0.25}" r="${r*0.3}"
        fill="rgba(255,255,255,0.45)" stroke="none"/>`;
    }
  }

  // ── Đường dọc dự đoán ────────────────────────────────────
  const predX = xs[n-1].toFixed(1);
  const predVLine = `
    <line x1="${predX}" y1="${PT}" x2="${predX}" y2="${H_TOP-PB}"
      stroke="#FF6600" stroke-width="1.5" stroke-dasharray="5,4" opacity="0.8"/>
    <line x1="${predX}" y1="${botBase+PT}" x2="${predX}" y2="${botBase+H_BOT-PB}"
      stroke="#FF6600" stroke-width="1.5" stroke-dasharray="5,4" opacity="0.8"/>`;

  // ── Nhãn trục X ─────────────────────────────────────────
  let xLabels = "";
  for (let i = 0; i < n; i++) {
    const p   = allPoints[i];
    const lbl = String(p.phien).slice(-4);
    xLabels += `<text x="${xs[i].toFixed(1)}" y="${botBase+H_BOT-PB+18}"
      fill="${p.fake ? '#FF7700' : '#C8A84B'}"
      font-size="${p.fake ? 11 : 10}" text-anchor="middle"
      font-family="Arial,sans-serif" font-weight="${p.fake ? 700 : 500}">${lbl}</text>`;
  }

  // ── Legend buttons (giống game) ──────────────────────────
  const legY  = botBase + H_BOT - PB + X_LBL + 6;
  const btnW  = 130, btnH = 28, btnR = 14;
  const gap   = 24;
  const totalBtnW = btnW * 3 + gap * 2;
  const startX = (W - totalBtnW) / 2;

  function legendBtn(x, label, gradId) {
    return `
      <rect x="${x}" y="${legY}" width="${btnW}" height="${btnH}" rx="${btnR}"
        fill="url(#${gradId})" stroke="rgba(255,255,255,0.3)" stroke-width="1"/>
      <text x="${x+btnW/2}" y="${legY+18}" fill="#fff" font-size="11"
        text-anchor="middle" font-family="Arial Black,Arial" font-weight="900"
        letter-spacing="1.5">${label}</text>`;
  }

  const CHART_TOTAL_H = legY + btnH + 8;

  const svg = `<svg viewBox="0 0 ${W} ${CHART_TOTAL_H}" xmlns="http://www.w3.org/2000/svg"
    style="width:100%;display:block;min-width:640px">
  <defs>
    <!-- Nền chart trên: nâu vàng đậm giống game -->
    <linearGradient id="bgTop" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#3C2400"/>
      <stop offset="100%" stop-color="#221400"/>
    </linearGradient>
    <!-- Nền chart dưới: tối hơn -->
    <linearGradient id="bgBot" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#2A1800"/>
      <stop offset="100%" stop-color="#140C00"/>
    </linearGradient>
    <!-- Nền giữa gap -->
    <linearGradient id="bgGap" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#1a0f00"/>
      <stop offset="100%" stop-color="#1a0f00"/>
    </linearGradient>
    <!-- Nút legend: tím, đỏ, xanh -->
    <linearGradient id="lg1" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#7700CC"/><stop offset="100%" stop-color="#CC00FF"/>
    </linearGradient>
    <linearGradient id="lg2" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#BB0000"/><stop offset="100%" stop-color="#FF3333"/>
    </linearGradient>
    <linearGradient id="lg3" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#007733"/><stop offset="100%" stop-color="#00CC55"/>
    </linearGradient>
    <!-- Glow filter -->
    <filter id="glow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="3" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <!-- Viền vàng nhẹ cho chart -->
    <linearGradient id="borderGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"   stop-color="#8B6914" stop-opacity="0.9"/>
      <stop offset="100%" stop-color="#5A4000" stop-opacity="0.7"/>
    </linearGradient>
  </defs>

  <!-- Backgrounds -->
  <rect x="0"          y="0"       width="${W}" height="${H_TOP}"      fill="url(#bgTop)"/>
  <rect x="0"          y="${H_TOP}" width="${W}" height="${GAP}"        fill="url(#bgGap)"/>
  <rect x="0"          y="${botBase}" width="${W}" height="${H_BOT}"    fill="url(#bgBot)"/>

  <!-- Viền phân cách giống game -->
  <line x1="0" y1="${H_TOP}" x2="${W}" y2="${H_TOP}" stroke="#6A4A00" stroke-width="1.5"/>
  <line x1="0" y1="${botBase}" x2="${W}" y2="${botBase}" stroke="#6A4A00" stroke-width="1.5"/>

  <!-- Grid -->
  ${gridV}
  ${gridHTop}
  ${gridHBot}

  <!-- Trục Y labels -->
  ${labelsTop}
  ${labelsBot}

  <!-- Đường dọc dự đoán (vẽ sau grid, trước đường) -->
  ${predVLine}

  <!-- Đường tổng -->
  ${sumLine}

  <!-- Đường xúc xắc -->
  ${diceLines}

  <!-- Dots xúc xắc (trên đường) -->
  ${diceDots}

  <!-- Dots tổng (trên cùng) -->
  ${sumDots}

  <!-- Nhãn X -->
  ${xLabels}

  <!-- Legend -->
  ${legendBtn(startX,              "XÍ NGẦU 1", "lg1")}
  ${legendBtn(startX + btnW + gap, "XÍ NGẦU 2", "lg2")}
  ${legendBtn(startX + (btnW+gap)*2, "XÍ NGẦU 3", "lg3")}
</svg>`;

  return svg;
}

// ══════════════════════════════════════════════════════════════
// HTTP SERVER
// ══════════════════════════════════════════════════════════════
http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, "http://localhost");

  // ── /predict ─────────────────────────────────────────────
  if (url.pathname === "/predict" || url.pathname === "/") {
    await syncHistory();

    const lastLocked = history[0] ?? null;
    if (!lastLocked && !pendingSession) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "Chưa có dữ liệu" }));
      return;
    }

    const phienHienTai = Number(lastLocked?.phien ?? pendingSession?.phien ?? 0);
    const ketQua       = lastLocked ? (lastLocked.type === "T" ? "Tài" : "Xỉu") : null;
    const diceSource   = lastLocked?.dice ?? lastDice ?? null;
    const xucXac       = diceSource ? [diceSource.d1, diceSource.d2, diceSource.d3] : null;

    const phienDuDoan = pendingSession
      ? Number(pendingSession.phien)
      : phienHienTai + 1;
    const phienDuDoanFinal = phienDuDoan > phienHienTai ? phienDuDoan : phienHienTai + 1;

    const pred = predict(history);
    const pattern = history.slice(0, 30).map(h => h.type === "T" ? "t" : "x").join("");

    res.writeHead(200);
    res.end(JSON.stringify({
      phien_hien_tai: phienHienTai,
      ket_qua:        ketQua,
      xuc_xac:        xucXac,
      phien_du_doan:  phienDuDoanFinal,
      du_doan:        pred.next === "T" ? "Tài" : pred.next === "X" ? "Xỉu" : "?",
      do_tin_cay:     pred.conf + "%",
      pattern,
      id:             BOT_ID
    }));
    return;
  }

  // ── /history ─────────────────────────────────────────────
  if (url.pathname === "/history") {
    await syncHistory();
    const data = history.slice(0, 50).map(h => ({
      phien:     h.phien,
      xuc_xac:   h.dice ? [h.dice.d1, h.dice.d2, h.dice.d3] : null,
      tong:      h.dice?.sum ?? null,
      ket_qua:   h.type === "T" ? "Tài" : "Xỉu",
      tai_pct:   Math.round(h.ratio * 100) + "%",
      xiu_pct:   Math.round((1 - h.ratio) * 100) + "%",
      cuoc_tai:  h.sTB,
      cuoc_xiu:  h.bTB,
      nguoi_tai: h.sTU,
      nguoi_xiu: h.bTU
    }));
    res.writeHead(200);
    res.end(JSON.stringify({ tong_phien: history.length, lay_50_gan_nhat: data.length, data }));
    return;
  }

  // ── /bieudo ───────────────────────────────────────────────
  if (url.pathname === "/bieudo") {
    await syncHistory();
    res.setHeader("Content-Type", "text/html; charset=utf-8");

    const pred     = predict(history);
    const fakeDice = generateFakeDiceForPrediction(pred, history);
    const svgChart = renderChartHTML(history, pred, fakeDice);

    const lastLocked = history[0] ?? null;
    const _raw = pendingSession ? Number(pendingSession.phien) : Number(lastLocked?.phien ?? 0) + 1;
    const _cur = Number(lastLocked?.phien ?? 0);
    const phienDuDoan = _raw > _cur ? _raw : _cur + 1;

    const diceStr  = lastLocked?.dice ? `${lastLocked.dice.d1}-${lastLocked.dice.d2}-${lastLocked.dice.d3}` : "—";
    const typeLabel = lastLocked?.type === "T" ? "Tài" : lastLocked?.type === "X" ? "Xỉu" : "—";
    const predLabel = pred.next === "T" ? "TÀI" : pred.next === "X" ? "XỈU" : "?";
    const predColor = pred.next === "T" ? "#E8C020" : "#A0A0A0";

    // Detail boxes
    const det = pred.detail;
    function detBox(label, obj, color) {
      if (!obj) return `<div class="det-box det-empty"><span class="det-lbl">${label}</span><span class="det-na">—</span></div>`;
      const c = obj.next === "T" ? "#E8C020" : "#A0A0A0";
      return `<div class="det-box">
        <span class="det-lbl">${label}</span>
        <span class="det-val" style="color:${c}">${obj.next === "T" ? "Tài" : "Xỉu"}</span>
        <span class="det-conf">${obj.conf}%</span>
        <span class="det-reason">${obj.reason}</span>
      </div>`;
    }

    const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Tài Xỉu — Biểu Đồ</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  background:radial-gradient(ellipse at 50% 0%,#4a2800 0%,#1a0900 60%,#0d0500 100%);
  min-height:100vh;
  font-family:"Arial Black",Arial,sans-serif;
  color:#fff;
  display:flex;flex-direction:column;align-items:center;
  padding:0 0 40px;
}

/* ── Header ── */
.header{
  width:100%;max-width:1120px;
  padding:18px 16px 10px;
  display:flex;align-items:center;justify-content:space-between;
  flex-wrap:wrap;gap:8px;
}
.header-title{
  display:flex;align-items:center;gap:10px;
  font-size:1.5rem;font-weight:900;letter-spacing:3px;
  color:#E8C020;
  text-shadow:0 0 20px rgba(232,192,32,0.5),0 2px 0 #6a4800;
  text-transform:uppercase;
}
.header-title svg{width:28px;height:28px}
.header-info{
  font-size:.85rem;font-weight:700;letter-spacing:.5px;color:#C8A84B;
  display:flex;gap:16px;align-items:center;flex-wrap:wrap;
}
.header-info .phien-lbl{color:rgba(255,255,255,.55);font-size:.75rem;font-weight:400;letter-spacing:1px}
.header-info .phien-val{color:#fff;font-size:.95rem;font-weight:900}
.tai-chip{
  background:#E8C020;color:#1a0900;
  padding:2px 10px;border-radius:20px;font-size:.8rem;font-weight:900;
}
.xiu-chip{
  background:#707070;color:#fff;
  padding:2px 10px;border-radius:20px;font-size:.8rem;font-weight:900;
}

/* ── Chart panel ── */
.chart-panel{
  width:100%;max-width:1120px;
  margin:0 8px 14px;
  background:linear-gradient(180deg,#3C2400 0%,#1E1000 100%);
  border:2px solid #7A5800;
  border-radius:14px;
  padding:10px 8px 6px;
  box-shadow:0 0 60px rgba(180,120,0,0.2),inset 0 1px 0 rgba(255,200,50,0.08);
  overflow:hidden;
}
.chart-scroll{overflow-x:auto;overflow-y:hidden}

/* ── Prediction + Detail ── */
.pred-section{
  width:100%;max-width:1120px;
  padding:0 8px;
  display:grid;
  grid-template-columns:auto 1fr;
  gap:12px;
  align-items:start;
}
.pred-main{
  background:linear-gradient(135deg,#4A2800,#8A5A00);
  border:2px solid #E8C020;
  border-radius:14px;
  padding:18px 36px;
  text-align:center;
  box-shadow:0 0 32px rgba(232,192,32,0.18);
  min-width:190px;
}
.pred-main .lbl{font-size:.7rem;letter-spacing:2.5px;color:rgba(255,255,255,.55);margin-bottom:4px}
.pred-main .phien-num{font-size:.85rem;color:#E8C020;font-weight:700;margin-bottom:8px}
.pred-main .val{font-size:2.6rem;font-weight:900;letter-spacing:2px;line-height:1;
  text-shadow:0 0 24px currentColor}
.pred-main .conf{font-size:.78rem;color:rgba(255,255,255,.55);margin-top:8px}

.det-grid{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:8px;
}
.det-box{
  background:rgba(255,255,255,.04);
  border:1.5px solid rgba(232,192,32,.15);
  border-radius:10px;
  padding:10px 14px;
  display:flex;flex-direction:column;gap:3px;
}
.det-box.det-empty{opacity:.4}
.det-lbl{font-size:.65rem;letter-spacing:2px;color:rgba(255,255,255,.45);text-transform:uppercase}
.det-val{font-size:1.1rem;font-weight:900}
.det-conf{font-size:.75rem;color:rgba(255,255,255,.5)}
.det-reason{font-size:.78rem;color:#C8A84B;margin-top:2px}

/* ── Bottom bar ── */
.bottom{
  width:100%;max-width:1120px;
  display:flex;justify-content:center;align-items:center;gap:16px;
  padding:16px 8px 0;flex-wrap:wrap;
}
.btn-refresh{
  padding:10px 32px;
  background:linear-gradient(135deg,#7B5000,#C88000);
  border:none;border-radius:22px;
  color:#fff;font-family:"Arial Black",Arial;font-size:.9rem;font-weight:900;
  cursor:pointer;letter-spacing:1px;
  box-shadow:0 4px 14px rgba(200,130,0,0.35);
  transition:all .2s;
}
.btn-refresh:hover{background:linear-gradient(135deg,#C88000,#E8C020);color:#000;transform:translateY(-1px)}
.nav-links{display:flex;gap:6px}
.nav-links a{
  padding:7px 16px;border-radius:16px;
  background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.1);
  color:#C8A84B;font-size:.8rem;text-decoration:none;font-weight:700;
  transition:all .15s;
}
.nav-links a:hover{background:rgba(255,255,255,.12);color:#fff}

@media(max-width:700px){
  .pred-section{grid-template-columns:1fr}
  .pred-main{padding:14px 20px}
  .det-grid{grid-template-columns:1fr}
}
</style>
</head>
<body>

<div class="header">
  <div class="header-title">
    <svg viewBox="0 0 28 28" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="1" y="1" width="26" height="26" rx="5" fill="#E8C020" stroke="#7A5000" stroke-width="2"/>
      <circle cx="8"  cy="8"  r="2.2" fill="#1a0900"/>
      <circle cx="20" cy="8"  r="2.2" fill="#1a0900"/>
      <circle cx="14" cy="14" r="2.2" fill="#1a0900"/>
      <circle cx="8"  cy="20" r="2.2" fill="#1a0900"/>
      <circle cx="20" cy="20" r="2.2" fill="#1a0900"/>
    </svg>
    TÀI XỈU — BIỂU ĐỒ
  </div>
  <div class="header-info">
    <div>
      <div class="phien-lbl">PHIÊN GẦN NHẤT</div>
      <div class="phien-val">#${lastLocked?.phien ?? "—"}</div>
    </div>
    <div>
      <div class="phien-lbl">KẾT QUẢ</div>
      <div style="margin-top:3px">
        ${lastLocked?.type === "T"
          ? `<span class="tai-chip">TÀI (${diceStr})</span>`
          : lastLocked?.type === "X"
            ? `<span class="xiu-chip">XỈU (${diceStr})</span>`
            : `<span style="color:#666">—</span>`}
      </div>
    </div>
  </div>
</div>

<div class="chart-panel">
  <div class="chart-scroll">
    ${svgChart || `<p style="color:#555;padding:60px;text-align:center;font-size:1rem">Đang chờ dữ liệu...</p>`}
  </div>
</div>

<div class="pred-section">
  <div class="pred-main">
    <div class="lbl">DỰ ĐOÁN PHIÊN</div>
    <div class="phien-num">#${phienDuDoan}</div>
    <div class="val" style="color:${predColor}">${predLabel}</div>
    <div class="conf">Độ tin cậy: <strong>${pred.conf}%</strong></div>
    <div class="conf" style="margin-top:6px;color:#C8A84B">${pred.reason}</div>
  </div>
  <div class="det-grid">
    ${detBox("BIỂU ĐỒ TỔNG",    det.sumChart,  "#E8C020")}
    ${detBox("BIỂU ĐỒ XÚC XẮC", det.diceChart, "#CC44FF")}
    ${detBox("PATTERN CẦU",      det.pattern,   "#00CC55")}
    ${detBox("TỶ LỆ CƯỢC",       det.betting,   "#FF9900")}
  </div>
</div>

<div class="bottom">
  <button class="btn-refresh" onclick="location.reload()">🔄 Làm mới</button>
  <div class="nav-links">
    <a href="/">JSON</a>
    <a href="/history">History</a>
    <a href="/bieudo">Biểu đồ</a>
    <a href="/debug">Debug</a>
  </div>
</div>

<script>
(function(){
  let cur = ${lastLocked?.phien ?? 0};
  function poll(){
    fetch("/predict").then(r=>r.json()).then(d=>{
      if(d.phien_hien_tai && d.phien_hien_tai !== cur) location.reload();
    }).catch(()=>{});
  }
  setInterval(poll, 3000);
})();
</script>
</body>
</html>`;

    res.writeHead(200);
    res.end(html);
    return;
  }

  // ── /debug ───────────────────────────────────────────────
  if (url.pathname === "/debug") {
    const r = await fetchSource().catch(e => ({ error: e.message }));
    res.writeHead(200);
    res.end(JSON.stringify({
      raw_api:         r,
      pending_session: pendingSession,
      last_dice:       lastDice,
      last_locked:     history[0] ?? null,
      history_count:   history.length
    }, null, 2));
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({
    error: "Không tìm thấy",
    endpoints: ["/", "/predict", "/history", "/bieudo", "/debug"]
  }));

}).listen(PORT, () => {
  console.log("✅ Tài Xỉu server — port " + PORT);
  console.log("   Source : " + SOURCE_URL);
  console.log("   Routes : / | /predict | /history | /bieudo | /debug");
  syncHistory();
  setInterval(syncHistory, 10000);
});
