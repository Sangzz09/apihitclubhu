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
// HỆ THỐNG DỰ ĐOÁN DỰA TRÊN BIỂU ĐỒ (Chart-Based Prediction)
// Phân tích pattern từ đồ thị tổng xúc xắc và từng xúc xắc
// ══════════════════════════════════════════════════════════════

// ── Phân tích xu hướng tổng (đường vàng) ──────────────────────
function analyzeSumChart(hist) {
  const sums = hist.map(h => h.dice?.sum ?? null).filter(x => x !== null);
  if (sums.length < 4) return null;

  const recent4 = sums.slice(0, 4);
  const older4  = sums.slice(4, 8);

  // Xu hướng tăng/giảm liên tiếp
  let trend = 0;
  for (let i = 1; i < Math.min(sums.length, 6); i++) {
    if (sums[i-1] > sums[i]) trend++;
    else if (sums[i-1] < sums[i]) trend--;
  }

  // Tổng trung bình gần nhất
  const avgRecent = recent4.reduce((a, b) => a + b, 0) / recent4.length;
  const avgOlder  = older4.length ? older4.reduce((a, b) => a + b, 0) / older4.length : avgRecent;

  // Phát hiện đỉnh/đáy local
  const isPeak   = sums[0] > sums[1] && sums[0] > sums[2];
  const isTrough = sums[0] < sums[1] && sums[0] < sums[2];

  // Biên độ dao động (volatility)
  const max4 = Math.max(...recent4);
  const min4 = Math.min(...recent4);
  const range = max4 - min4;

  // Dự đoán dựa trên xu hướng tổng
  let next = null, conf = 0.52, reason = "";

  if (isPeak && sums[0] >= 14) {
    // Vừa đạt đỉnh cao → khả năng giảm về Xỉu
    next = "X"; conf = 0.60 + Math.min((sums[0] - 14) * 0.02, 0.10);
    reason = `Đỉnh cao (${sums[0]}) → Xỉu`;
  } else if (isTrough && sums[0] <= 7) {
    // Vừa đạt đáy thấp → khả năng tăng về Tài
    next = "T"; conf = 0.60 + Math.min((7 - sums[0]) * 0.02, 0.10);
    reason = `Đáy thấp (${sums[0]}) → Tài`;
  } else if (trend >= 3 && avgRecent > 11) {
    // Xu hướng tăng mạnh đang hướng về Tài
    next = "T"; conf = 0.57;
    reason = "Xu hướng tổng tăng";
  } else if (trend <= -3 && avgRecent < 11) {
    // Xu hướng giảm mạnh
    next = "X"; conf = 0.57;
    reason = "Xu hướng tổng giảm";
  } else if (range >= 8) {
    // Biên độ rộng → phân tích mean reversion
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

// ── Phân tích từng xúc xắc (đường màu) ───────────────────────
function analyzeDiceChart(hist) {
  const diceHist = hist.filter(h => h.dice).slice(0, 15);
  if (diceHist.length < 5) return null;

  const d1s = diceHist.map(h => h.dice.d1);
  const d2s = diceHist.map(h => h.dice.d2);
  const d3s = diceHist.map(h => h.dice.d3);

  // Phân tích xu hướng từng xúc xắc (như 3 đường màu trong game)
  function diceAvg(arr, n) {
    return arr.slice(0, n).reduce((a, b) => a + b, 0) / n;
  }

  const avg1_3 = diceAvg(d1s, 3), avg1_6 = diceAvg(d1s, 6);
  const avg2_3 = diceAvg(d2s, 3), avg2_6 = diceAvg(d2s, 6);
  const avg3_3 = diceAvg(d3s, 3), avg3_6 = diceAvg(d3s, 6);

  // Momentum của từng xúc xắc
  const mom1 = avg1_3 - avg1_6;
  const mom2 = avg2_3 - avg2_6;
  const mom3 = avg3_3 - avg3_6;

  const totalMom = mom1 + mom2 + mom3;

  // Dự đoán tổng kỳ tiếp dựa trên momentum
  const predictedAvgPerDice = 3.5 + totalMom * 0.3;
  const predictedSum = predictedAvgPerDice * 3;

  // Pattern xen kẽ trong từng xúc xắc
  function isAlternating(arr, n) {
    let alt = 0;
    for (let i = 1; i < Math.min(arr.length, n); i++) {
      if ((arr[i-1] > 3.5) !== (arr[i] > 3.5)) alt++;
    }
    return alt >= n - 2;
  }

  const alt1 = isAlternating(d1s, 5);
  const alt2 = isAlternating(d2s, 5);
  const alt3 = isAlternating(d3s, 5);
  const altCount = [alt1, alt2, alt3].filter(Boolean).length;

  let next = null, conf = 0.52, reason = "";

  if (altCount >= 2) {
    // Các xúc xắc đang xen kẽ → tiếp tục pattern ngược
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

// ── Phân tích pattern cầu từ sequence ──────────────────────────
function analyzePattern(hist) {
  if (hist.length < 4) return null;
  const seq = hist.map(h => h.type);
  const s   = seq.join("");

  // Cầu bệt
  const betLen = (() => {
    let l = 1;
    while (l < seq.length && seq[l] === seq[0]) l++;
    return l;
  })();

  if (betLen >= 5) {
    return { next: seq[0] === "T" ? "X" : "T", conf: 0.65, reason: `Bệt ${betLen}, dự phá` };
  }
  if (betLen >= 3) {
    return { next: seq[0], conf: 0.58, reason: `Bệt ${betLen}, tiếp tục` };
  }

  // Cầu 1-1
  let alt = 1;
  for (let i = 1; i < Math.min(seq.length, 12); i++) {
    if (seq[i] !== seq[i-1]) alt++;
    else break;
  }
  if (alt >= 6) return { next: seq[0] === "T" ? "X" : "T", conf: 0.72, reason: `Cầu 1-1 (${alt})` };
  if (alt >= 4) return { next: seq[0] === "T" ? "X" : "T", conf: 0.63, reason: `Cầu 1-1 (${alt})` };

  // Cầu 2-2
  if (s.length >= 8 &&
      s[0] === s[1] && s[2] === s[3] && s[0] !== s[2] &&
      s[4] === s[5] && s[0] === s[4])
    return { next: s[0], conf: 0.66, reason: "Cầu 2-2" };

  // Cầu 3-3
  if (s.length >= 6 &&
      s[0] === s[1] && s[1] === s[2] &&
      s[3] === s[4] && s[4] === s[5] && s[0] !== s[3])
    return { next: s[0], conf: 0.64, reason: "Cầu 3-3" };

  // Chu kỳ
  for (const p of [2, 3, 4]) {
    if (s.length >= p * 3) {
      const c = s.slice(0, p);
      if (s.slice(p, p*2) === c && s.slice(p*2, p*3) === c)
        return { next: c[0], conf: 0.63, reason: `Chu kỳ ${p}` };
    }
  }

  return null;
}

// ── Phân tích tỷ lệ cược (crowd wisdom) ─────────────────────────
function analyzeBetting(hist) {
  // Ưu tiên ratio của pendingSession (mới nhất) nếu có
  const r = pendingSession?.ratio ?? hist[0]?.ratio ?? 0.5;

  // Crowd thường sai khi lệch mạnh → contrarian
  if (r > 0.68) return { next: "T", conf: 0.58, reason: `Crowd Tài ${Math.round(r*100)}%` };
  if (r < 0.32) return { next: "X", conf: 0.58, reason: `Crowd Xỉu ${Math.round((1-r)*100)}%` };

  // Crowd moderate → follow
  if (r > 0.60) return { next: "T", conf: 0.54, reason: `Crowd nhẹ Tài ${Math.round(r*100)}%` };
  if (r < 0.40) return { next: "X", conf: 0.54, reason: `Crowd nhẹ Xỉu ${Math.round((1-r)*100)}%` };

  // Gần 50/50
  return { next: r >= 0.5 ? "T" : "X", conf: 0.51, reason: `Cân bằng Tài ${Math.round(r*100)}% / Xỉu ${Math.round((1-r)*100)}%` };
}

// ── ENSEMBLE dự đoán tổng hợp ─────────────────────────────────
function predict(hist) {
  // Fallback khi không có history: dùng tỷ lệ cược pendingSession
  if (hist.length < 1) {
    const ps = pendingSession;
    if (ps) {
      const r = ps.ratio ?? 0.5;
      const next = r >= 0.5 ? "T" : "X";
      const conf = Math.round((0.50 + Math.abs(r - 0.5) * 0.6) * 100);
      const reason = `Tỷ lệ cược: Tài ${Math.round(r*100)}% / Xỉu ${Math.round((1-r)*100)}%`;
      return { next, conf, reason,
        detail: { sumChart: null, diceChart: null, pattern: null,
          betting: { next, conf, reason } } };
    }
    return { next: "T", conf: 52, reason: "Khởi động...",
      detail: { sumChart: null, diceChart: null, pattern: null, betting: null } };
  }

  // 1-2 phiên: dùng betting + cầu đơn giản
  if (hist.length < 3) {
    const bettingRes = analyzeBetting(hist);
    const lastType = hist[0]?.type ?? "T";
    // Nếu có pendingSession thì dùng ratio của nó (mới hơn)
    const ps = pendingSession;
    let bettingFinal = bettingRes;
    if (ps) {
      const r = ps.ratio ?? 0.5;
      if (r > 0.60) bettingFinal = { next: "T", conf: 0.53 + (r-0.60)*0.3, reason: `Crowd Tài ${Math.round(r*100)}%` };
      else if (r < 0.40) bettingFinal = { next: "X", conf: 0.53 + (0.40-r)*0.3, reason: `Crowd Xỉu ${Math.round((1-r)*100)}%` };
    }
    const next = bettingFinal?.next ?? lastType;
    const conf = bettingFinal ? Math.round(bettingFinal.conf * 100) : 52;
    const reason = bettingFinal?.reason ?? `Ít dữ liệu — theo ${next === "T" ? "Tài" : "Xỉu"}`;
    return { next, conf, reason,
      detail: { sumChart: null, diceChart: null, pattern: null,
        betting: { next, conf, reason } } };
  }

  const sumChartResult  = analyzeSumChart(hist);
  const diceChartResult = analyzeDiceChart(hist);
  const patternResult   = analyzePattern(hist);
  const bettingResult   = analyzeBetting(hist);

  // Trọng số
  const sources = [
    { w: 3.0, r: sumChartResult  },  // Biểu đồ tổng (quan trọng nhất)
    { w: 2.5, r: diceChartResult },  // Biểu đồ từng xúc xắc
    { w: 2.0, r: patternResult   },  // Pattern sequence
    { w: 1.5, r: bettingResult   },  // Tỷ lệ cược
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

  const reason = patternResult?.reason
    ?? sumChartResult?.reason
    ?? diceChartResult?.reason
    ?? bettingResult?.reason
    ?? (next === "T" ? "Nghiêng Tài" : "Nghiêng Xỉu");

  return {
    next,
    conf: Math.round(conf * 100),
    reason,
    detail: {
      sumChart:  sumChartResult  ? { next: sumChartResult.next,  conf: Math.round(sumChartResult.conf * 100),  reason: sumChartResult.reason  } : null,
      diceChart: diceChartResult ? { next: diceChartResult.next, conf: Math.round(diceChartResult.conf * 100), reason: diceChartResult.reason } : null,
      pattern:   patternResult   ? { next: patternResult.next,   conf: Math.round(patternResult.conf * 100),   reason: patternResult.reason   } : null,
      betting:   bettingResult   ? { next: bettingResult.next,   conf: Math.round(bettingResult.conf * 100),   reason: bettingResult.reason   } : null,
    }
  };
}

// ══════════════════════════════════════════════════════════════
// SINH DỮ LIỆU FAKE CHO PHIÊN DỰ ĐOÁN TIẾP THEO
// Tạo xúc xắc "giả lập" để vẽ biểu đồ điểm tiếp theo
// ══════════════════════════════════════════════════════════════
function generateFakeDiceForPrediction(pred, hist) {
  const histWithDice = hist.filter(h => h.dice).slice(0, 10);
  if (!histWithDice.length) {
    // Fallback random theo dự đoán
    if (pred.next === "T") {
      const sum = 11 + Math.floor(Math.random() * 7); // 11-17
      const d1 = Math.ceil(sum / 3), d2 = Math.ceil((sum - d1) / 2), d3 = sum - d1 - d2;
      return { d1: Math.min(d1, 6), d2: Math.min(d2, 6), d3: Math.max(d3, 1), sum };
    } else {
      const sum = 4 + Math.floor(Math.random() * 7); // 4-10
      const d1 = Math.ceil(sum / 3), d2 = Math.ceil((sum - d1) / 2), d3 = sum - d1 - d2;
      return { d1: Math.min(d1, 6), d2: Math.min(d2, 6), d3: Math.max(d3, 1), sum };
    }
  }

  // Dựa vào xu hướng thực tế của từng xúc xắc
  const recentD1 = histWithDice.slice(0, 4).map(h => h.dice.d1);
  const recentD2 = histWithDice.slice(0, 4).map(h => h.dice.d2);
  const recentD3 = histWithDice.slice(0, 4).map(h => h.dice.d3);

  const avgD1 = recentD1.reduce((a, b) => a + b, 0) / recentD1.length;
  const avgD2 = recentD2.reduce((a, b) => a + b, 0) / recentD2.length;
  const avgD3 = recentD3.reduce((a, b) => a + b, 0) / recentD3.length;

  // Xu hướng từng xúc xắc
  const trendD1 = recentD1[0] - recentD1[recentD1.length - 1];
  const trendD2 = recentD2[0] - recentD2[recentD2.length - 1];
  const trendD3 = recentD3[0] - recentD3[recentD3.length - 1];

  // Tạo giá trị dự đoán từng xúc xắc theo trend + noise nhỏ
  const clamp = (v) => Math.min(6, Math.max(1, Math.round(v)));
  let pd1 = clamp(avgD1 + trendD1 * 0.3 + (Math.random() - 0.5) * 1.5);
  let pd2 = clamp(avgD2 + trendD2 * 0.3 + (Math.random() - 0.5) * 1.5);
  let pd3 = clamp(avgD3 + trendD3 * 0.3 + (Math.random() - 0.5) * 1.5);

  let psum = pd1 + pd2 + pd3;

  // Điều chỉnh để khớp với dự đoán T/X
  if (pred.next === "T" && psum < 11) {
    const diff = 11 - psum;
    pd1 = clamp(pd1 + Math.ceil(diff / 3));
    pd2 = clamp(pd2 + Math.ceil(diff / 3));
    pd3 = clamp(pd3 + Math.floor(diff / 3));
    psum = pd1 + pd2 + pd3;
    if (psum < 11) pd1 = Math.min(6, pd1 + (11 - psum));
  } else if (pred.next === "X" && psum >= 11) {
    const diff = psum - 10;
    pd1 = clamp(pd1 - Math.ceil(diff / 3));
    pd2 = clamp(pd2 - Math.ceil(diff / 3));
    pd3 = clamp(pd3 - Math.floor(diff / 3));
    psum = pd1 + pd2 + pd3;
    if (psum >= 11) pd1 = Math.max(1, pd1 - (psum - 10));
  }

  return {
    d1: pd1, d2: pd2, d3: pd3,
    sum: pd1 + pd2 + pd3,
    fake: true
  };
}

// ══════════════════════════════════════════════════════════════
// HTML BIỂU ĐỒ (giống game thật)
// ══════════════════════════════════════════════════════════════
function renderChartHTML(hist, pred, fakeDice) {
  const displayHist = hist.filter(h => h.dice).slice(0, 19);
  displayHist.reverse();

  const predPhien = displayHist.length
    ? String(Number(displayHist[displayHist.length - 1].phien) + 1)
    : "???";

  const allPoints = [
    ...displayHist.map(h => ({
      phien: h.phien, sum: h.dice.sum,
      d1: h.dice.d1, d2: h.dice.d2, d3: h.dice.d3,
      type: h.type, fake: false
    })),
    { phien: predPhien, sum: fakeDice.sum,
      d1: fakeDice.d1, d2: fakeDice.d2, d3: fakeDice.d3,
      type: pred.next, fake: true }
  ];

  const n = allPoints.length;
  if (n < 2) return "";

  // ── Kích thước SVG responsive ──────────────────────────────
  const W = 1000;
  const PL = 52, PR = 20;          // padding left/right
  const PT = 28, PB = 28;          // padding top/bottom (trong vùng chart)
  const H_TOP = 240;               // chiều cao vùng biểu đồ trên
  const GAP   = 32;                // khoảng cách giữa 2 chart
  const H_BOT = 220;               // chiều cao vùng biểu đồ dưới
  const LEG   = 36;                // legend height
  const TOTAL = H_TOP + GAP + H_BOT + LEG;
  const chartW = W - PL - PR;
  const colW   = n > 1 ? chartW / (n - 1) : chartW;
  const xs     = allPoints.map((_, i) => PL + i * colW);

  // ── Hàm tọa độ Y ──────────────────────────────────────────
  function sumY(v) {
    return PT + (H_TOP - PT - PB) * (1 - (v - 3) / 15);
  }
  const botBase = H_TOP + GAP;
  function diceY(v) {
    return botBase + PT + (H_BOT - PT - PB) * (1 - (v - 1) / 5);
  }

  // ── Grid vàng mờ (giống game) ─────────────────────────────
  // Grid dọc
  let gridV = "";
  for (let i = 0; i < n; i++) {
    gridV += `<line x1="${xs[i]}" y1="${PT}" x2="${xs[i]}" y2="${H_TOP - PB}" stroke="rgba(180,140,40,0.25)" stroke-width="1"/>`;
    gridV += `<line x1="${xs[i]}" y1="${botBase+PT}" x2="${xs[i]}" y2="${botBase+H_BOT-PB}" stroke="rgba(180,140,40,0.25)" stroke-width="1"/>`;
  }

  // Grid ngang trên (3,6,9,12,15,18)
  let gridHTop = "", labelsTop = "";
  for (const v of [3,6,9,12,15,18]) {
    const y = sumY(v);
    gridHTop += `<line x1="${PL}" y1="${y}" x2="${W-PR}" y2="${y}" stroke="rgba(180,140,40,0.30)" stroke-width="1"/>`;
    labelsTop += `<text x="${PL-8}" y="${y+4}" fill="#C8A84B" font-size="12" text-anchor="end" font-family="Arial Black,Arial,sans-serif" font-weight="900">${v}</text>`;
  }

  // Grid ngang dưới (1-6)
  let gridHBot = "", labelsBot = "";
  for (const v of [1,2,3,4,5,6]) {
    const y = diceY(v);
    gridHBot += `<line x1="${PL}" y1="${y}" x2="${W-PR}" y2="${y}" stroke="rgba(180,140,40,0.30)" stroke-width="1"/>`;
    labelsBot += `<text x="${PL-8}" y="${y+4}" fill="#C8A84B" font-size="12" text-anchor="end" font-family="Arial Black,Arial,sans-serif" font-weight="900">${v}</text>`;
  }

  // ── Đường tổng (vàng) ─────────────────────────────────────
  const sumPolyPts = allPoints.map((p,i) => `${xs[i]},${sumY(p.sum)}`).join(" ");
  const sumLine = `<polyline points="${sumPolyPts}" fill="none" stroke="#FFD700" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>`;

  // Dots tổng: hình tròn lớn có viền đen + số bên trong (như game)
  let sumDots = "";
  for (let i = 0; i < n; i++) {
    const p = allPoints[i];
    const y = sumY(p.sum);
    const isT = p.sum >= 11;
    const isFake = p.fake;
    const r = isFake ? 18 : 16;
    const fill = isFake ? "#FF5500" : (isT ? "#F5C518" : "#B0B0B0");
    const textFill = isFake ? "#fff" : (isT ? "#1a0d00" : "#1a1a1a");
    const strokeC = isFake ? "#FF2200" : "#1a0d00";
    sumDots += `<circle cx="${xs[i]}" cy="${y}" r="${r}" fill="${fill}" stroke="${strokeC}" stroke-width="3"/>`;
    sumDots += `<text x="${xs[i]}" y="${y+5}" fill="${textFill}" font-size="${isFake?13:12}" text-anchor="middle" font-family="Arial Black,Arial" font-weight="900">${p.sum}</text>`;
    if (isFake) {
      sumDots += `<text x="${xs[i]}" y="${y+r+14}" fill="#FF5500" font-size="10" text-anchor="middle" font-family="Arial,sans-serif" font-weight="700">DỰ</text>`;
    }
  }

  // ── 3 đường xúc xắc (như game: hồng/đỏ/xanh lá) ──────────
  const DC = ["#FF69B4","#FF3333","#33DD66"];
  let diceLines = "", diceDots = "";

  for (let d = 0; d < 3; d++) {
    const key = d === 0 ? "d1" : d === 1 ? "d2" : "d3";
    const pts = allPoints.map((p,i) => `${xs[i]},${diceY(p[key])}`).join(" ");
    diceLines += `<polyline points="${pts}" fill="none" stroke="${DC[d]}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    for (let i = 0; i < n; i++) {
      const p = allPoints[i];
      const y = diceY(p[key]);
      const isFake = p.fake;
      const r = isFake ? 10 : 9;
      // Outer glow ring
      diceDots += `<circle cx="${xs[i]}" cy="${y}" r="${r+3}" fill="${DC[d]}" opacity="0.25"/>`;
      diceDots += `<circle cx="${xs[i]}" cy="${y}" r="${r}" fill="${DC[d]}" stroke="#111" stroke-width="2.5"/>`;
    }
  }

  // ── Đường dọc dự đoán ─────────────────────────────────────
  const predX = xs[n-1];
  const predVLine = `<line x1="${predX}" y1="${PT}" x2="${predX}" y2="${botBase+H_BOT-PB}" stroke="#FF6600" stroke-width="1.5" stroke-dasharray="6,4" opacity="0.7"/>`;

  // ── Phiên labels (trục X dưới cùng) ──────────────────────
  let xLabels = "";
  for (let i = 0; i < n; i++) {
    const p = allPoints[i];
    const lbl = String(p.phien).slice(-4);
    xLabels += `<text x="${xs[i]}" y="${botBase+H_BOT-PB+18}" fill="${p.fake?"#FF6600":"#C8A84B"}" font-size="${p.fake?11:10}" text-anchor="middle" font-family="Arial,sans-serif" font-weight="${p.fake?700:400}">${lbl}</text>`;
  }

  // ── Legend (3 nút XÍ NGẦU như game) ───────────────────────
  const legY = botBase + H_BOT - PB + 36;
  const btnW = 120, btnH = 26, btnR = 13;
  const btn1X = W/2 - btnW - 20, btn2X = W/2 - btnW/2, btn3X = W/2 + btnW/2 + 20 - 20;

  function diceBtn(x, label, c1, c2, tc) {
    return `
      <rect x="${x}" y="${legY}" width="${btnW}" height="${btnH}" rx="${btnR}" fill="url(#btn${label.slice(-1)})" stroke="${c1}" stroke-width="1.5"/>
      <text x="${x+btnW/2}" y="${legY+17}" fill="${tc}" font-size="11" text-anchor="middle" font-family="Arial Black,Arial" font-weight="900" letter-spacing="1">${label}</text>`;
  }

  const svg = `<svg viewBox="0 0 ${W} ${TOTAL}" xmlns="http://www.w3.org/2000/svg" style="width:100%;display:block">
  <defs>
    <linearGradient id="bgTop" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#3d2200"/>
      <stop offset="100%" stop-color="#251500"/>
    </linearGradient>
    <linearGradient id="bgBot" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2a1800"/>
      <stop offset="100%" stop-color="#1a0d00"/>
    </linearGradient>
    <linearGradient id="btn1" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#8B00CC"/><stop offset="100%" stop-color="#CC00FF"/>
    </linearGradient>
    <linearGradient id="btn2" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#CC2200"/><stop offset="100%" stop-color="#FF4400"/>
    </linearGradient>
    <linearGradient id="btn3" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#006633"/><stop offset="100%" stop-color="#00AA55"/>
    </linearGradient>
    <filter id="glow"><feGaussianBlur stdDeviation="2" result="blur"/><feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>

  <!-- Background top chart -->
  <rect x="0" y="0" width="${W}" height="${H_TOP}" fill="url(#bgTop)" rx="0"/>
  <!-- Background bottom chart -->
  <rect x="0" y="${botBase}" width="${W}" height="${H_BOT}" fill="url(#bgBot)" rx="0"/>

  <!-- Grid -->
  ${gridV}${gridHTop}${gridHBot}

  <!-- Đường tổng -->
  ${sumLine}
  ${sumDots}

  <!-- Đường xúc xắc -->
  ${diceLines}
  ${diceDots}

  <!-- Labels -->
  ${labelsTop}${labelsBot}
  ${xLabels}

  <!-- Prediction vertical line -->
  ${predVLine}

  <!-- Legend buttons -->
  ${diceBtn(btn1X, "XÍ NGẦU 1", "#CC00FF", "#8B00CC", "#fff")}
  ${diceBtn(btn2X, "XÍ NGẦU 2", "#FF4400", "#CC2200", "#fff")}
  ${diceBtn(btn3X, "XÍ NGẦU 3", "#00AA55", "#006633", "#fff")}
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

  // ── / và /predict ───────────────────────────────────────────
  if (url.pathname === "/predict" || url.pathname === "/") {
    await syncHistory();

    // lastLocked = phiên cuối đã có kết quả (trong history)
    // pendingSession = phiên đang mở cược (chưa có kết quả)
    const lastLocked = history[0] ?? null;

    if (!lastLocked && !pendingSession) {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "Chưa có dữ liệu" }));
      return;
    }

    // Phiên hiện tại = phiên gần nhất đã có kết quả (lastLocked)
    // hoặc nếu chưa có history thì lấy pendingSession tạm
    const phienHienTai = Number(lastLocked?.phien ?? pendingSession?.phien ?? 0);

    // Kết quả phiên hiện tại (từ history đã lock)
    const ketQua = lastLocked
      ? (lastLocked.type === "T" ? "Tài" : "Xỉu")
      : null;

    // Xúc xắc phiên hiện tại
    const diceSource = lastLocked?.dice ?? lastDice ?? null;
    const xucXac     = diceSource ? [diceSource.d1, diceSource.d2, diceSource.d3] : null;

    // Phiên dự đoán = phiên ĐANG mở cược (pendingSession) nếu có,
    // hoặc phiên hiện tại + 1
    const phienDuDoan = pendingSession
      ? Number(pendingSession.phien)        // phiên đang cược → đây là phiên cần dự đoán
      : phienHienTai + 1;                   // chưa có pending → tiếp theo

    // Đảm bảo phiên dự đoán luôn > phiên hiện tại
    const phienDuDoanFinal = phienDuDoan > phienHienTai
      ? phienDuDoan
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
      phien_du_doan:  phienDuDoanFinal,
      du_doan:        pred.next === "T" ? "Tài" : pred.next === "X" ? "Xỉu" : "?",
      do_tin_cay:     pred.conf + "%",
      pattern,
      id:             BOT_ID
    }));
    return;
  }

  // ── /history ─────────────────────────────────────────────────
  if (url.pathname === "/history") {
    await syncHistory();

    const lim = 50; // luôn lấy 50 phiên gần nhất
    const data = history.slice(0, lim).map(h => ({
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
    res.end(JSON.stringify({
      tong_phien: history.length,
      lay_50_gan_nhat: data.length,
      data
    }));
    return;
  }

  // ── /bieudo ───────────────────────────────────────────────────
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

    const diceStr = lastLocked?.dice
      ? `${lastLocked.dice.d1}-${lastLocked.dice.d2}-${lastLocked.dice.d3}`
      : "—";
    const typeLabel = lastLocked?.type === "T" ? "Tài" : lastLocked?.type === "X" ? "Xỉu" : "—";
    const predLabel = pred.next === "T" ? "TÀI" : pred.next === "X" ? "XỈU" : "?";
    const predColor = pred.next === "T" ? "#F5C518" : "#C0C0C0";

    const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Lịch Sử Phiên</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{
  background:radial-gradient(ellipse at 50% 0%,#4a2800 0%,#1a0900 55%,#0a0400 100%);
  min-height:100vh;
  font-family:"Arial Black",Arial,sans-serif;
  color:#fff;
  display:flex;
  flex-direction:column;
  align-items:center;
  padding:0 0 32px;
}
/* ── Header ── */
.header{
  width:100%;max-width:1060px;
  text-align:center;
  padding:18px 12px 10px;
}
.header-title{
  display:inline-flex;align-items:center;gap:10px;
  font-size:1.9rem;font-weight:900;letter-spacing:4px;
  color:#FFD700;
  text-shadow:0 0 24px rgba(255,210,0,0.6),0 2px 0 #7a5000;
  text-transform:uppercase;
  margin-bottom:10px;
}
.header-title svg{width:32px;height:32px;flex-shrink:0}
.header-sub{
  font-size:1rem;font-weight:700;letter-spacing:1px;
  color:#FFD700;
}
.header-sub span{color:#fff;font-size:1.05rem}
/* ── Chart panel ── */
.panel{
  width:100%;max-width:1060px;
  background:linear-gradient(180deg,#3d2200 0%,#1e1000 100%);
  border:2.5px solid #8B6000;
  border-radius:16px;
  padding:14px 10px 6px;
  margin:0 8px;
  box-shadow:0 0 50px rgba(200,130,0,0.25),inset 0 1px 0 rgba(255,200,50,0.1);
  overflow:hidden;
}
.chart-scroll{overflow-x:auto;overflow-y:hidden}
/* ── Prediction box ── */
.pred-wrap{
  width:100%;max-width:1060px;
  display:flex;gap:12px;flex-wrap:wrap;
  justify-content:center;
  padding:14px 8px 0;
}
.pred-main{
  background:linear-gradient(135deg,#5a3800,#9a6200);
  border:2px solid #FFD700;
  border-radius:14px;
  padding:16px 32px;
  text-align:center;
  box-shadow:0 0 28px rgba(255,215,0,0.2);
  min-width:200px;
}
.pred-main .lbl{font-size:.75rem;letter-spacing:2px;color:rgba(255,255,255,.65);margin-bottom:4px}
.pred-main .phien{font-size:.9rem;color:#FFD700;font-weight:700;margin-bottom:6px}
.pred-main .val{font-size:2.4rem;font-weight:900;letter-spacing:2px;text-shadow:0 0 20px currentColor}
.pred-main .conf{font-size:.8rem;color:rgba(255,255,255,.6);margin-top:6px}
.pred-reason{
  background:rgba(255,255,255,.04);
  border:1.5px solid rgba(255,215,0,.18);
  border-radius:14px;
  padding:14px 24px;
  text-align:center;
  min-width:160px;
  display:flex;flex-direction:column;justify-content:center;
}
.pred-reason .lbl{font-size:.7rem;letter-spacing:2px;color:rgba(255,255,255,.5);margin-bottom:6px}
.pred-reason .val{font-size:.95rem;font-weight:700;color:#ccc;line-height:1.4}
/* ── Auto refresh ── */
.bottom{
  width:100%;max-width:1060px;
  display:flex;justify-content:center;align-items:center;gap:16px;
  padding:14px 8px 0;
  flex-wrap:wrap;
}
.btn-refresh{
  padding:9px 28px;
  background:linear-gradient(135deg,#7b5800,#c88000);
  border:none;border-radius:20px;
  color:#fff;font-family:"Arial Black",Arial;font-size:.9rem;font-weight:900;
  cursor:pointer;letter-spacing:1px;
  box-shadow:0 4px 12px rgba(200,130,0,0.3);
}
.btn-refresh:hover{background:linear-gradient(135deg,#c88000,#FFD700);color:#000}
.links a{color:#8B6914;font-size:.8rem;margin:0 8px;text-decoration:none}
.links a:hover{color:#FFD700}
</style>
</head>
<body>
<div class="header">
  <div class="header-title">
    <svg viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="2" y="2" width="28" height="28" rx="6" fill="#FFD700" stroke="#7a5000" stroke-width="2"/>
      <circle cx="9" cy="9" r="2.5" fill="#1a0900"/>
      <circle cx="23" cy="9" r="2.5" fill="#1a0900"/>
      <circle cx="16" cy="16" r="2.5" fill="#1a0900"/>
      <circle cx="9" cy="23" r="2.5" fill="#1a0900"/>
      <circle cx="23" cy="23" r="2.5" fill="#1a0900"/>
    </svg>
    LỊCH SỬ PHIÊN
  </div>
  <div class="header-sub">
    Phiên gần nhất: <span>#${lastLocked?.phien ?? "—"}</span>
    &nbsp;&nbsp;
    <span style="color:${lastLocked?.type==="T"?"#F5C518":"#B0B0B0"}">${typeLabel} (${diceStr})</span>
  </div>
</div>

<div class="panel">
  <div class="chart-scroll">${svgChart || "<p style='color:#888;padding:40px;text-align:center'>Đang chờ dữ liệu...</p>"}</div>
</div>

<div class="pred-wrap">
  <div class="pred-main">
    <div class="lbl">DỰ ĐOÁN PHIÊN</div>
    <div class="phien">#${phienDuDoan}</div>
    <div class="val" style="color:${predColor}">${predLabel}</div>
    <div class="conf">Độ tin cậy: ${pred.conf}%</div>
  </div>
  <div class="pred-reason">
    <div class="lbl">PHÂN TÍCH</div>
    <div class="val">${pred.reason}</div>
  </div>
</div>

<div class="bottom">
  <button class="btn-refresh" onclick="location.reload()">🔄 Làm mới</button>
  <div class="links">
    <a href="/">JSON</a>
    <a href="/history">History</a>
    <a href="/bieudo">Biểu đồ</a>
    <a href="/debug">Debug</a>
  </div>
</div>

<script>
(function(){
  let currentPhien = ${lastLocked?.phien ?? 0};
  function check(){
    fetch("/predict").then(r=>r.json()).then(d=>{
      if(d.phien_hien_tai && d.phien_hien_tai !== currentPhien){
        location.reload();
      }
    }).catch(()=>{});
  }
  setInterval(check, 3000);
})();
</script>
</body>
</html>`;

    res.writeHead(200);
    res.end(html);
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
  console.log("✅ Tài Xỉu prediction server port " + PORT);
  console.log("   Source: " + SOURCE_URL);
  console.log("   Routes: / | /predict | /history | /bieudo | /debug");
  syncHistory();
  setInterval(syncHistory, 10000);
});
