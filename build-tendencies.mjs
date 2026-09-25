// Builds data/tendencies.json for xO Football from CollegeFootballData.com.
// Runs on GitHub Actions with the CFBD_API_KEY secret. The key never reaches the app.
import { writeFile, mkdir } from "node:fs/promises";

const KEY = process.env.CFBD_API_KEY;
if (!KEY) { console.error("Missing the CFBD_API_KEY secret. Add it under Settings > Secrets and variables > Actions."); process.exit(1); }

const now = new Date();
const YEAR = Number(process.env.SEASON_YEAR) || (now.getUTCMonth() < 1 ? now.getUTCFullYear() - 1 : now.getUTCFullYear());
const BASE = process.env.CFBD_BASE || "https://api.collegefootballdata.com";

async function get(path) {
  const r = await fetch(BASE + path, { headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" } });
  if (!r.ok) throw new Error(`${path} returned ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
const pick = (o, ...ks) => { for (const k of ks) if (o && o[k] != null) return o[k]; return null; };
const num = v => (v == null || v === "" || isNaN(+v)) ? null : +v;
const r1 = v => v == null ? null : Math.round(v * 10) / 10;
const r2 = v => v == null ? null : Math.round(v * 100) / 100;

const fbs = await get(`/teams/fbs?year=${YEAR}`);
const names = new Set(fbs.map(t => pick(t, "school", "name")).filter(Boolean));
console.log(`Season ${YEAR}: ${names.size} FBS teams`);

const basicRows = await get(`/stats/season?year=${YEAR}`);
const basic = {};
for (const row of basicRows) {
  const team = pick(row, "team", "school"); if (!names.has(team)) continue;
  (basic[team] ||= {})[pick(row, "statName", "stat_name")] = num(pick(row, "statValue", "stat_value"));
}

let games = [];
try { games = await get(`/games?year=${YEAR}&seasonType=regular&classification=fbs`); }
catch (e) { console.warn("games (classification):", e.message); try { games = await get(`/games?year=${YEAR}&seasonType=regular&division=fbs`); } catch (e2) { console.warn("games:", e2.message); } }
try { games = games.concat(await get(`/games?year=${YEAR}&seasonType=postseason&classification=fbs`)); } catch (e) {}
const results = {};
for (const g of games) {
  const done = pick(g, "completed"); const hp = num(pick(g, "homePoints", "home_points")), ap = num(pick(g, "awayPoints", "away_points"));
  if (done === false || hp == null || ap == null) continue;
  const h = pick(g, "homeTeam", "home_team"), a = pick(g, "awayTeam", "away_team");
  for (const [t, pf, pa] of [[h, hp, ap], [a, ap, hp]]) {
    if (!names.has(t)) continue;
    const x = results[t] ||= { g: 0, w: 0, l: 0, pf: 0, pa: 0 };
    x.g++; x.pf += pf; x.pa += pa; if (pf > pa) x.w++; else if (pf < pa) x.l++;
  }
}

let adv = [];
try { adv = await get(`/stats/season/advanced?year=${YEAR}`); } catch (e) { console.warn("advanced:", e.message); }
const advBy = {}; for (const row of adv) advBy[pick(row, "team", "school")] = row;

const teams = {};
for (const team of names) {
  const b = basic[team] || {}, res = results[team], a = advBy[team];
  const rushAtt = b.rushingAttempts, passAtt = b.passAttempts, plays = (rushAtt || 0) + (passAtt || 0);
  const takeaways = (b.fumblesRecovered || 0) + (b.passesIntercepted || 0);
  const giveaways = b.turnovers != null ? b.turnovers : (b.fumblesLost || 0) + (b.interceptions || 0);
  const tape = {
    games: res ? res.g : b.games ?? null,
    w: res ? res.w : null, l: res ? res.l : null,
    ppg: res && res.g ? r1(res.pf / res.g) : null, papg: res && res.g ? r1(res.pa / res.g) : null,
    run: plays ? r1(rushAtt / plays * 100) : null,
    ypp: plays && b.totalYards != null ? r1(b.totalYards / plays) : null,
    ypc: rushAtt && b.rushingYards != null ? r1(b.rushingYards / rushAtt) : null,
    ypa: passAtt && b.netPassingYards != null ? r1(b.netPassingYards / passAtt) : null,
    third: b.thirdDowns ? r1(b.thirdDownConversions / b.thirdDowns * 100) : null,
    tom: (b.fumblesRecovered != null || b.passesIntercepted != null) ? takeaways - giveaways : null
  };
  let tend = null;
  if (a && a.offense && a.defense) {
    const o = a.offense, d = a.defense, pc = v => v == null ? null : r1(v * 100);
    tend = {
      runRate: pc(o.rushingPlays && o.rushingPlays.rate),
      sr: pc(o.successRate), expl: r2(o.explosiveness),
      pdsr: pc(o.passingDowns && o.passingDowns.successRate),
      lineYds: r1(o.lineYards), stuffAllowed: pc(o.stuffRate),
      dSr: pc(d.successRate), dExpl: r2(d.explosiveness),
      dHavoc: pc(d.havoc && d.havoc.total)
    };
  }
  teams[team] = { tape, tend };
}

await mkdir("data", { recursive: true });
await writeFile("data/tendencies.json", JSON.stringify({ updated: new Date().toISOString(), year: YEAR, source: "CollegeFootballData.com", teams }));
console.log(`Wrote data/tendencies.json for ${Object.keys(teams).length} teams`);
