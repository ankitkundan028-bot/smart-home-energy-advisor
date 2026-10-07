'use strict';

// Node.js 18+ required for built-in fetch.
const [major] = process.versions.node.split('.').map(Number);
if (major < 18) {
  console.error(`❌  Node.js 18+ required (found ${process.versions.node}). Please upgrade.`);
  process.exit(1);
}

const http = require('http');
const fs = require('fs');
const path = require('path');

// ─── MSEDCL Residential Tariff Config ────────────────────────────────────────
// ⚠ Verify these rates against your latest MSEDCL bill or
//   https://www.mahadiscom.in/consumer/tariff/ before use.
const MSEDCL = {
  // Energy charge slabs (paise per unit = ₹ per kWh * 100)
  slabs: [
    { upTo: 100,  ratePerUnit: 3.95 }, // 0 – 100 units
    { upTo: 300,  ratePerUnit: 7.65 }, // 101 – 300 units
    { upTo: 500,  ratePerUnit: 10.35 }, // 301 – 500 units
    { upTo: Infinity, ratePerUnit: 11.45 } // 500+ units
  ],
  fixedChargePerMonth: 110,     // ₹ / month (single-phase up to 1 kW)
  wheelingChargePerUnit: 0.85,  // ₹ / unit
  fuelAdjustmentPerUnit: 0.22,  // ₹ / unit (FAC – changes quarterly)
  electricityDutyPct: 0.16      // 16 % on energy charges
};
// ─────────────────────────────────────────────────────────────────────────────

// ─── Parse .env file manually (no dotenv dependency) ────────────────────────
function loadEnv() {
  const envPath = path.join(__dirname, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
    if (key && !(key in process.env)) process.env[key] = val;
  }
}
loadEnv();

// ─── CSV helpers ─────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim());
    const obj = {};
    headers.forEach((h, i) => { obj[h] = vals[i] ?? ''; });
    return obj;
  });
}

function loadAppliances() {
  const csvPath = path.join(__dirname, 'data', 'appliances.csv');
  if (!fs.existsSync(csvPath)) return [];
  return parseCSV(fs.readFileSync(csvPath, 'utf8'));
}

// ─── Energy calculations ──────────────────────────────────────────────────────
function calcEnergy(appliances) {
  return appliances.map(a => {
    const watts = parseFloat(a.watts) || 0;
    const qty   = parseFloat(a.quantity) || 0;
    const hours = parseFloat(a.hours_per_day) || 0;
    const kwhPerDay   = (watts * qty * hours) / 1000;
    const kwhPerMonth = kwhPerDay * 30;
    return { ...a, kwhPerDay: +kwhPerDay.toFixed(3), kwhPerMonth: +kwhPerMonth.toFixed(2) };
  });
}

function calcBill(totalKwh) {
  let remaining = totalKwh;
  let energyCharge = 0;
  const breakdown = [];

  for (const slab of MSEDCL.slabs) {
    if (remaining <= 0) break;
    const prevUpTo = breakdown.length === 0 ? 0 : MSEDCL.slabs[breakdown.length - 1].upTo;
    const slabSize = slab.upTo === Infinity ? remaining : Math.min(slab.upTo - prevUpTo, remaining);
    const units    = Math.min(slabSize, remaining);
    const charge   = units * slab.ratePerUnit;
    breakdown.push({
      range: slab.upTo === Infinity
        ? `${prevUpTo}+ units`
        : `${prevUpTo + 1}–${slab.upTo} units`,
      units: +units.toFixed(2),
      rate: slab.ratePerUnit,
      charge: +charge.toFixed(2)
    });
    energyCharge += charge;
    remaining    -= units;
  }

  const wheelingCharge   = totalKwh * MSEDCL.wheelingChargePerUnit;
  const fuelAdjustment   = totalKwh * MSEDCL.fuelAdjustmentPerUnit;
  const electricityDuty  = energyCharge * MSEDCL.electricityDutyPct;
  const total = energyCharge + wheelingCharge + fuelAdjustment +
                electricityDuty + MSEDCL.fixedChargePerMonth;

  return {
    totalKwh: +totalKwh.toFixed(2),
    slabBreakdown: breakdown,
    energyCharge:      +energyCharge.toFixed(2),
    wheelingCharge:    +wheelingCharge.toFixed(2),
    fuelAdjustment:    +fuelAdjustment.toFixed(2),
    electricityDuty:   +electricityDuty.toFixed(2),
    fixedCharge:       MSEDCL.fixedChargePerMonth,
    totalBill:         +total.toFixed(2)
  };
}

// ─── Hourly load profile ─────────────────────────────────────────────────────
function buildHourlyProfile(appliances) {
  const profile = Array(24).fill(0);
  for (const a of appliances) {
    const watts  = parseFloat(a.watts) || 0;
    const qty    = parseFloat(a.quantity) || 0;
    const hours  = parseFloat(a.hours_per_day) || 0;
    const startMatch = String(a.start_time || '00:00').match(/^(\d{1,2}):(\d{2})$/);
    const startHour  = startMatch ? parseInt(startMatch[1], 10) : 0;
    const totalWatts = watts * qty;
    for (let h = 0; h < Math.ceil(hours); h++) {
      const hr     = (startHour + h) % 24;
      // last fractional hour
      const factor = (h === Math.floor(hours) && hours % 1 !== 0) ? (hours % 1) : 1;
      profile[hr]  += totalWatts * factor;
    }
  }
  return profile.map(w => +w.toFixed(0));
}

// ─── Top N helper ────────────────────────────────────────────────────────────
function topN(arr, key, n) {
  return [...arr].sort((a, b) => b[key] - a[key]).slice(0, n);
}

// ─── watsonx.ai / Granite tips ───────────────────────────────────────────────
async function getIAMToken(apiKey) {
  const body = `grant_type=urn%3Aibm%3Aparams%3Aoauth%3Agrant-type%3Aapikey&apikey=${encodeURIComponent(apiKey)}`;
  const res = await fetch('https://iam.cloud.ibm.com/identity/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  if (!res.ok) throw new Error(`IAM token error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

async function getGraniteTips(appliancesWithEnergy, billInfo) {
  const apiKey    = process.env.WATSONX_API_KEY;
  const projectId = process.env.WATSONX_PROJECT_ID;
  const wxUrl     = process.env.WATSONX_URL || 'https://us-south.ml.cloud.ibm.com';
  const modelId   = process.env.WATSONX_MODEL_ID || 'ibm/granite-3-8b-instruct';

  if (!apiKey || apiKey === 'your_ibm_cloud_api_key_here' ||
      !projectId || projectId === 'your_watsonx_project_id_here') {
    return { source: 'fallback', reason: 'WATSONX_API_KEY or WATSONX_PROJECT_ID not configured', tips: ruleBased(appliancesWithEnergy) };
  }

  try {
    const token = await getIAMToken(apiKey);
    const top3  = topN(appliancesWithEnergy, 'kwhPerMonth', 3).map(a => `${a.name} (${a.kwhPerMonth} kWh/month)`).join(', ');
    const prompt = `You are an energy efficiency expert for Indian homes. 
The household's top 3 energy consumers are: ${top3}.
Monthly bill estimate: ₹${billInfo.totalBill}.
Provide exactly 5 concise, practical, India-specific energy-saving tips numbered 1 to 5.`;

    const payload = {
      model_id: modelId,
      project_id: projectId,
      messages: [
        { role: 'system', content: 'You are a helpful energy advisor for Indian homes.' },
        { role: 'user',   content: prompt }
      ],
      parameters: { max_new_tokens: 400, temperature: 0.7 }
    };

    const res = await fetch(`${wxUrl}/ml/v1/text/chat?version=2023-05-29`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`watsonx API ${res.status}: ${errText}`);
    }

    const data    = await res.json();
    const content = data?.choices?.[0]?.message?.content || '';
    return { source: 'granite', tips: content };
  } catch (err) {
    return { source: 'fallback', reason: err.message, tips: ruleBased(appliancesWithEnergy) };
  }
}

function ruleBased(appliancesWithEnergy) {
  const top = topN(appliancesWithEnergy, 'kwhPerMonth', 3);
  const tips = [
    '1. Use a 5-star BEE-rated inverter AC and set the thermostat to 24°C – saves up to 24% energy.',
    '2. Replace old incandescent or CFL bulbs with LED lights to cut lighting costs by up to 80%.',
    '3. Run washing machine and dishwasher with full loads during off-peak hours (before 6 AM or after 10 PM).',
    '4. Switch off appliances at the wall socket – standby power can account for 5-10% of your bill.',
    '5. Solar water heaters can eliminate geyser electricity use and pay back in 3-5 years in India.'
  ];
  if (top[0]) tips.push(`💡 Your biggest consumer is ${top[0].name} at ${top[0].kwhPerMonth} kWh/month – consider usage reduction.`);
  return tips.join('\n');
}

// ─── Request body reader ─────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ─── Static file server ──────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.csv':  'text/csv'
};

function serveStatic(res, filePath) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const ext  = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(filePath).pipe(res);
}

function json(res, data, status = 200) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

// ─── HTTP Server ─────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url    = new URL(req.url, `http://localhost`);
  const method = req.method.toUpperCase();

  // CORS pre-flight
  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end(); return;
  }

  // ── GET / → index.html
  if (method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    serveStatic(res, path.join(__dirname, 'public', 'index.html')); return;
  }

  // ── GET /api/appliances
  if (method === 'GET' && url.pathname === '/api/appliances') {
    json(res, loadAppliances()); return;
  }

  // ── POST /api/analyze  { appliances: [...] }
  if (method === 'POST' && url.pathname === '/api/analyze') {
    try {
      const body        = await readBody(req);
      const { appliances } = JSON.parse(body);
      if (!Array.isArray(appliances)) { json(res, { error: 'appliances must be an array' }, 400); return; }

      const withEnergy  = calcEnergy(appliances);
      const totalKwh    = withEnergy.reduce((s, a) => s + a.kwhPerMonth, 0);
      const totalKwhDay = withEnergy.reduce((s, a) => s + a.kwhPerDay, 0);
      const bill        = calcBill(totalKwh);
      const sorted      = topN(withEnergy, 'kwhPerMonth', withEnergy.length);
      const top3        = sorted.slice(0, 3);
      const hourly      = buildHourlyProfile(appliances);
      const peakVal     = Math.max(...hourly);
      const top3Hours   = hourly
        .map((w, i) => ({ hour: i, watts: w }))
        .sort((a, b) => b.watts - a.watts)
        .slice(0, 3)
        .map(x => x.hour);

      // 30-day daily usage (slight random variation ±3%)
      const daily30 = Array.from({ length: 30 }, (_, i) => {
        const jitter = 1 + (Math.sin(i * 7.3) * 0.03);
        return +(totalKwhDay * jitter).toFixed(2);
      });

      json(res, {
        appliances: withEnergy,
        totalKwhPerMonth: +totalKwh.toFixed(2),
        totalKwhPerDay:   +totalKwhDay.toFixed(3),
        top3Consumers: top3,
        hourlyProfile: hourly,
        peakWatts: peakVal,
        top3PeakHours: top3Hours,
        daily30,
        bill,
        shareData: withEnergy.map(a => ({
          name: a.name,
          kwhPerMonth: a.kwhPerMonth,
          share: totalKwh > 0 ? +(a.kwhPerMonth / totalKwh * 100).toFixed(1) : 0
        }))
      });
    } catch (e) {
      json(res, { error: e.message }, 500);
    }
    return;
  }

  // ── POST /api/tips  { appliances, bill }
  if (method === 'POST' && url.pathname === '/api/tips') {
    try {
      const body = await readBody(req);
      const { appliances, bill } = JSON.parse(body);
      const withEnergy = calcEnergy(appliances || []);
      const billInfo   = bill || calcBill(withEnergy.reduce((s, a) => s + a.kwhPerMonth, 0));
      const result     = await getGraniteTips(withEnergy, billInfo);
      json(res, result);
    } catch (e) {
      json(res, { source: 'fallback', reason: e.message, tips: 'Unable to generate tips.' }, 500);
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => {
  console.log(`\n🏠  Smart Home Energy Advisor`);
  console.log(`🌐  http://localhost:${PORT}\n`);
});
