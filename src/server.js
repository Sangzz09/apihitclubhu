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
  // Lấy 20 phiên gần nhất + 1 phiên dự đoán
  const displayHist = hist.filter(h => h.dice).slice(0, 19);
  displayHist.reverse(); // cũ → mới (trái → phải)

  // Thêm phiên dự đoán vào cuối
  const predPhien = displayHist.length
    ? String(Number(displayHist[displayHist.length - 1].phien) + 1)
    : "???";

  const allPoints = [
    ...displayHist.map(h => ({
      phien: h.phien,
      sum: h.dice.sum,
      d1: h.dice.d1,
      d2: h.dice.d2,
      d3: h.dice.d3,
      type: h.type,
      fake: false
    })),
    {
      phien: predPhien,
      sum: fakeDice.sum,
      d1: fakeDice.d1,
      d2: fakeDice.d2,
      d3: fakeDice.d3,
      type: pred.next,
      fake: true
    }
  ];

  const n = allPoints.length;
  if (n < 2) return "<p style='color:#fff'>Chưa đủ dữ liệu</p>";

  // SVG dimensions
  const W = 900, H_TOP = 200, H_BOT = 180, PAD = 50, BOT_PAD = 30;
  const colW = (W - PAD * 2) / (n - 1);

  // Tọa độ X cho mỗi điểm
  const xs = allPoints.map((_, i) => PAD + i * colW);

  // ── Biểu đồ TRÊN: tổng xúc xắc (3-18) ──────────────────────
  const sumMin = 3, sumMax = 18;
  function sumY(v) {
    return H_TOP - 20 - ((v - sumMin) / (sumMax - sumMin)) * (H_TOP - 40);
  }

  // Grid lines cho biểu đồ trên
  const gridVals = [3, 6, 9, 12, 15, 18];
  let topGridLines = "";
  for (const v of gridVals) {
    const y = sumY(v);
    topGridLines += `<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="rgba(255,255,255,0.15)" stroke-width="1"/>`;
    topGridLines += `<text x="${PAD - 8}" y="${y + 4}" fill="rgba(255,255,255,0.6)" font-size="10" text-anchor="end">${v}</text>`;
  }

  // Polyline tổng
  const sumPts = allPoints.map((p, i) => `${xs[i]},${sumY(p.sum)}`).join(" ");
  let topPath = `<polyline points="${sumPts}" fill="none" stroke="#FFD700" stroke-width="2.5" stroke-linejoin="round"/>`;

  // Dots tổng + labels
  let topDots = "";
  for (let i = 0; i < allPoints.length; i++) {
    const p = allPoints[i];
    const y = sumY(p.sum);
    const isFake = p.fake;
    const fillColor = isFake ? "#FF6B35" : (p.sum >= 11 ? "#F5C518" : "#C0C0C0");
    const strokeColor = isFake ? "#FF3300" : "#333";
    topDots += `<circle cx="${xs[i]}" cy="${y}" r="${isFake ? 7 : 6}" fill="${fillColor}" stroke="${strokeColor}" stroke-width="${isFake ? 2 : 1.5}"/>`;
    topDots += `<text x="${xs[i]}" y="${y - 10}" fill="${isFake ? "#FF6B35" : "#FFD700"}" font-size="${isFake ? 11 : 10}" text-anchor="middle" font-weight="${isFake ? 'bold' : 'normal'}">${p.sum}</text>`;
    if (isFake) {
      topDots += `<text x="${xs[i]}" y="${y + 20}" fill="#FF6B35" font-size="9" text-anchor="middle" font-style="italic">DỰ</text>`;
    }
  }

  // ── Biểu đồ DƯỚI: từng xúc xắc (1-6) ───────────────────────
  const diceMin = 1, diceMax = 6;
  const botTop = H_TOP + 30;
  function diceY(v) {
    return botTop + H_BOT - 15 - ((v - diceMin) / (diceMax - diceMin)) * (H_BOT - 30);
  }

  // Grid lines dưới
  let botGridLines = "";
  for (let v = 1; v <= 6; v++) {
    const y = diceY(v);
    botGridLines += `<line x1="${PAD}" y1="${y}" x2="${W - PAD}" y2="${y}" stroke="rgba(255,255,255,0.12)" stroke-width="1"/>`;
    botGridLines += `<text x="${PAD - 8}" y="${y + 4}" fill="rgba(255,255,255,0.5)" font-size="10" text-anchor="end">${v}</text>`;
  }

  // 3 đường xúc xắc
  const diceColors = ["#FF69B4", "#FF4444", "#66FF66"]; // pink, red, green (như game)
  let botPaths = "", botDots = "";

  for (let d = 0; d < 3; d++) {
    const vals = d === 0 ? "d1" : d === 1 ? "d2" : "d3";
    const pts = allPoints.map((p, i) => `${xs[i]},${diceY(p[vals])}`).join(" ");
    botPaths += `<polyline points="${pts}" fill="none" stroke="${diceColors[d]}" stroke-width="2" stroke-linejoin="round" opacity="0.9"/>`;
    for (let i = 0; i < allPoints.length; i++) {
      const p = allPoints[i];
      const y = diceY(p[vals]);
      const isFake = p.fake;
      botDots += `<circle cx="${xs[i]}" cy="${y}" r="${isFake ? 6 : 5}" fill="${diceColors[d]}" stroke="${isFake ? "#FF3300" : "#1a1a1a"}" stroke-width="${isFake ? 2 : 1.5}" opacity="${isFake ? 1 : 0.95}"/>`;
    }
  }

  // Vertical line dự đoán
  const predX = xs[xs.length - 1];
  const predLine = `
    <line x1="${predX}" y1="0" x2="${predX}" y2="${H_TOP + H_BOT + 40}" stroke="rgba(255,100,0,0.5)" stroke-width="1.5" stroke-dasharray="4,3"/>
  `;

  const totalH = H_TOP + H_BOT + 60;

  const svgContent = `
<svg viewBox="0 0 ${W} ${totalH}" xmlns="http://www.w3.org/2000/svg" style="width:100%;max-width:900px;display:block;margin:0 auto">
  <defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2a1a00"/>
      <stop offset="100%" stop-color="#1a0d00"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${totalH}" fill="url(#bgGrad)" rx="8"/>
  ${predLine}
  ${topGridLines}
  ${topPath}
  ${topDots}
  <line x1="${PAD}" y1="${H_TOP + 15}" x2="${W - PAD}" y2="${H_TOP + 15}" stroke="rgba(255,255,255,0.2)" stroke-width="1.5"/>
  ${botGridLines}
  ${botPaths}
  ${botDots}
  <!-- Phiên labels bottom -->
  ${allPoints.map((p, i) => `
    <text x="${xs[i]}" y="${totalH - 5}" fill="${p.fake ? '#FF6B35' : 'rgba(255,255,255,0.5)'}" font-size="${p.fake ? 9 : 8}" text-anchor="middle" font-weight="${p.fake ? 'bold' : 'normal'}">${String(p.phien).slice(-4)}</text>
  `).join("")}
  <!-- Legend -->
  <circle cx="${W - 180}" cy="${H_TOP + 8}" r="5" fill="#FF69B4"/>
  <text x="${W - 172}" y="${H_TOP + 12}" fill="rgba(255,255,255,0.7)" font-size="10">Xí Ngầu 1</text>
  <circle cx="${W - 120}" cy="${H_TOP + 8}" r="5" fill="#FF4444"/>
  <text x="${W - 112}" y="${H_TOP + 12}" fill="rgba(255,255,255,0.7)" font-size="10">Xí Ngầu 2</text>
  <circle cx="${W - 60}" cy="${H_TOP + 8}" r="5" fill="#66FF66"/>
  <text x="${W - 52}" y="${H_TOP + 12}" fill="rgba(255,255,255,0.7)" font-size="10">Xí Ngầu 3</text>
</svg>`;

  return svgContent;
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

    if (!history.length) {
      res.writeHead(503);
      res.end("<html><body style='background:#1a0d00;color:#fff;font-family:sans-serif;padding:40px'><h2>Chưa có dữ liệu</h2></body></html>");
      return;
    }

    const pred     = predict(history);
    const fakeDice = generateFakeDiceForPrediction(pred, history);
    const svgChart = renderChartHTML(history, pred, fakeDice);

    const lastLocked   = history[0];
    const _phienDuDoanRaw = pendingSession
      ? Number(pendingSession.phien)
      : Number(lastLocked?.phien ?? 0) + 1;
    const _phienHienTaiRaw = Number(lastLocked?.phien ?? 0);
    const phienDuDoan = _phienDuDoanRaw > _phienHienTaiRaw
      ? _phienDuDoanRaw
      : _phienHienTaiRaw + 1;

    const predColor = pred.next === "T" ? "#F5C518" : "#C0C0C0";
    const predBg    = pred.next === "T" ? "linear-gradient(135deg,#7b5800,#c88000)" : "linear-gradient(135deg,#3a3a5c,#6060aa)";

    const html = `<!DOCTYPE html>
<html lang="vi">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Lịch Sử Phiên - Tài Xỉu</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Saira+Condensed:wght@400;600;700;900&family=Roboto+Mono:wght@400;700&display=swap');
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: radial-gradient(ellipse at top, #2a1500 0%, #0d0800 60%);
    min-height: 100vh;
    font-family: 'Saira Condensed', sans-serif;
    color: #fff;
    padding: 16px;
  }
  .container {
    max-width: 960px;
    margin: 0 auto;
    background: rgba(60,30,0,0.6);
    border: 2px solid #8B6914;
    border-radius: 12px;
    padding: 20px;
    box-shadow: 0 0 40px rgba(200,140,0,0.3);
  }
  h1 {
    text-align: center;
    font-size: 1.8rem;
    font-weight: 900;
    letter-spacing: 3px;
    color: #FFD700;
    text-shadow: 0 0 20px rgba(255,215,0,0.5);
    margin-bottom: 10px;
    text-transform: uppercase;
  }
  .latest {
    text-align: center;
    margin-bottom: 16px;
    font-size: 1rem;
    color: #FFD700;
  }
  .latest span { color: #fff; font-weight: 700; }
  .chart-wrap {
    background: rgba(20,10,0,0.8);
    border: 1px solid #5a4200;
    border-radius: 8px;
    padding: 12px 4px;
    margin-bottom: 16px;
    overflow-x: auto;
  }
  .pred-box {
    display: flex;
    gap: 12px;
    flex-wrap: wrap;
    justify-content: center;
    margin-bottom: 16px;
  }
  .pred-card {
    background: ${predBg};
    border: 2px solid ${predColor};
    border-radius: 10px;
    padding: 14px 28px;
    text-align: center;
    min-width: 180px;
    box-shadow: 0 0 20px rgba(255,215,0,0.2);
  }
  .pred-card .label { font-size: 0.8rem; color: rgba(255,255,255,0.7); margin-bottom: 4px; letter-spacing: 1px; }
  .pred-card .value { font-size: 2rem; font-weight: 900; color: ${predColor}; text-shadow: 0 0 15px ${predColor}; }
  .pred-card .sub   { font-size: 0.8rem; color: rgba(255,255,255,0.6); margin-top: 4px; }
  .info-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
    gap: 8px;
    margin-bottom: 16px;
  }
  .info-card {
    background: rgba(255,255,255,0.05);
    border: 1px solid rgba(255,215,0,0.2);
    border-radius: 8px;
    padding: 10px 14px;
  }
  .info-card .k { font-size: 0.7rem; color: rgba(255,255,255,0.5); text-transform: uppercase; letter-spacing: 1px; }
  .info-card .v { font-size: 1rem; font-weight: 700; color: #FFD700; margin-top: 2px; }
  .fake-dice {
    text-align: center;
    background: rgba(255,100,0,0.1);
    border: 1px dashed rgba(255,100,0,0.5);
    border-radius: 8px;
    padding: 10px;
    margin-bottom: 12px;
    font-size: 0.85rem;
    color: rgba(255,150,50,0.9);
  }
  .api-links {
    text-align: center;
    margin-top: 10px;
    font-size: 0.8rem;
  }
  .api-links a {
    color: #8B6914;
    margin: 0 8px;
    text-decoration: none;
  }
  .api-links a:hover { color: #FFD700; }
  .refresh-btn {
    display: block;
    margin: 0 auto 14px;
    padding: 8px 24px;
    background: linear-gradient(135deg,#7b5800,#c88000);
    border: none;
    border-radius: 6px;
    color: #fff;
    font-family: 'Saira Condensed',sans-serif;
    font-size: 1rem;
    font-weight: 700;
    cursor: pointer;
    letter-spacing: 1px;
  }
  .refresh-btn:hover { background: linear-gradient(135deg,#c88000,#FFD700); color: #000; }
</style>
</head>
<body>
<div class="container">
  <h1>🎲 Lịch Sử Phiên</h1>
  <div class="latest">
    Phiên gần nhất: <span>#${lastLocked?.phien ?? "—"}</span>
    &nbsp;|&nbsp;
    <span style="color:${lastLocked?.type === "T" ? "#F5C518" : "#C0C0C0"}">${lastLocked?.type === "T" ? "Tài" : "Xỉu"}
    ${lastLocked?.dice ? `(${lastLocked.dice.d1}-${lastLocked.dice.d2}-${lastLocked.dice.d3})` : ""}</span>
  </div>

  <div class="chart-wrap">
    ${svgChart}
  </div>

  <div class="pred-box">
    <div class="pred-card">
      <div class="label">DỰ ĐOÁN PHIÊN</div>
      <div class="value" style="font-size:1rem;margin-bottom:4px">#${phienDuDoan}</div>
      <div class="value">${pred.next === "T" ? "🟡 TÀI" : "⚪ XỈU"}</div>
      <div class="sub">Tin cậy: ${pred.conf}%</div>
    </div>
    <div class="pred-card" style="background:rgba(255,255,255,0.05);border-color:rgba(255,255,255,0.2)">
      <div class="label">LÝ DO</div>
      <div class="value" style="font-size:1rem;color:#aaa;margin-top:8px">${pred.reason}</div>
    </div>
  </div>

  <div class="fake-dice">
    🎲 Xúc xắc dự đoán phiên ${phienDuDoan}:
    <strong>${fakeDice.d1} - ${fakeDice.d2} - ${fakeDice.d3}</strong>
    = Tổng <strong>${fakeDice.sum}</strong>
    → <strong>${fakeDice.sum >= 11 ? "TÀI" : "XỈU"}</strong>
    (điểm cam trên biểu đồ)
  </div>

  <div class="info-grid">
    ${pred.detail.sumChart ? `<div class="info-card"><div class="k">Biểu đồ Tổng</div><div class="v">${pred.detail.sumChart.next === "T" ? "Tài" : "Xỉu"} (${pred.detail.sumChart.conf}%)</div></div>` : ""}
    ${pred.detail.diceChart ? `<div class="info-card"><div class="k">Biểu đồ Xúc Xắc</div><div class="v">${pred.detail.diceChart.next === "T" ? "Tài" : "Xỉu"} (${pred.detail.diceChart.conf}%)</div></div>` : ""}
    ${pred.detail.pattern ? `<div class="info-card"><div class="k">Pattern Cầu</div><div class="v">${pred.detail.pattern.next === "T" ? "Tài" : "Xỉu"} (${pred.detail.pattern.conf}%)</div></div>` : ""}
    ${pred.detail.betting ? `<div class="info-card"><div class="k">Tỷ Lệ Cược</div><div class="v">${pred.detail.betting.next === "T" ? "Tài" : "Xỉu"} (${pred.detail.betting.conf}%)</div></div>` : ""}
    <div class="info-card"><div class="k">Tổng Phiên</div><div class="v">${history.length}</div></div>
    <div class="info-card"><div class="k">Bot ID</div><div class="v" style="font-size:0.8rem">${BOT_ID}</div></div>
  </div>

  <button class="refresh-btn" onclick="location.reload()">🔄 Làm Mới</button>

  <div class="api-links">
    <a href="/predict">/ JSON</a>
    <a href="/history">/ History 50</a>
    <a href="/bieudo">/ Biểu Đồ</a>
    <a href="/debug">/ Debug</a>
  </div>
</div>
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
