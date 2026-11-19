const aliases = new Map(Object.entries({
  earbuds: 'earphones', earbud: 'earphones', headphones: 'earphones', headset: 'earphones',
  id: 'identity', mobile: 'phone', cellphone: 'phone', backpack: 'bag', keychain: 'keys',
  grey: 'gray', spectacles: 'glasses', eyeglasses: 'glasses'
}));
const genericWords = new Set(('a an and at by for from in is it my of on or the to with without lost found ' +
  'campus sstc item items near left missing please someone something unknown other small large new old ' +
  'black white blue brown silver gold pink green purple gray red yellow orange multicolour transparent').split(' '));
const activeStates = new Set(['', 'open', 'possible match']);
const dayLength = 86400000;

function tokenize(text) {
  const words = String(text ?? '').normalize('NFKC').toLowerCase().match(/[\p{L}\p{M}\p{N}]+/gu) || [];
  return words.map(word => aliases.get(word) || word);
}

function overlap(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared++;
  return shared / Math.sqrt(left.size * right.size);
}

function textSimilarity(a, b) {
  return overlap(new Set(tokenize(a)), new Set(tokenize(b)));
}

function field(value) {
  const text = tokenize(value).join(' ');
  return ['unknown', 'na', 'n a', 'unsure', 'other', 'not sure', 'not known'].includes(text) ? '' : text;
}

function dateNumber(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return NaN;
  const time = Date.parse(value + 'T00:00:00Z');
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value) return NaN;
  return time / dayLength;
}

function dayDistance(a, b) {
  const days = Math.abs(dateNumber(a) - dateNumber(b));
  return Number.isFinite(days) ? days : 999;
}

function features(report) {
  const category = field(report.category);
  const color = field(report.color);
  const location = field(report.location);
  // Location and colour already contribute their own evidence.
  const excluded = new Set([...genericWords, ...tokenize(color), ...tokenize(location)]);
  const words = tokenize([report.title, report.description].filter(Boolean).join(' '));
  return {report, category, color, location, day: dateNumber(report.date),
    words: new Set(words.filter(word => !excluded.has(word)))};
}

function scoreFeatures(lost, found) {
  const similarity = overlap(lost.words, found.words);
  const days = Math.abs(lost.day - found.day);
  if (!similarity || days > 7) return {score: 0, reasons: []};
  let score = Math.round(40 * similarity);
  const reasons = ['similar item wording'];
  if (lost.category && lost.category === found.category) { score += 15; reasons.push('same category'); }
  if (lost.location && lost.location === found.location) { score += 20; reasons.push('same location'); }
  if (lost.color && lost.color === found.color) { score += 15; reasons.push('same colour'); }
  if (days <= 7) { score += days <= 1 ? 10 : 5; reasons.push(days <= 1 ? 'close date' : 'same week'); }
  return {score, reasons};
}

function scoreMatch(lost, found) {
  return scoreFeatures(features(lost), features(found));
}

function findMatches(reports, {limit = 25} = {}) {
  const capacity = Number.isFinite(limit) ? Math.max(0, Math.min(100, Math.floor(limit))) : 25;
  const matches = [];
  if (!capacity) return matches;
  const lostItems = [];
  const foundByWord = new Map();
  for (const report of reports) {
    if (!report || !activeStates.has(String(report.status ?? '').trim().toLowerCase())) continue;
    if (report.type !== 'lost' && report.type !== 'found') continue;
    const item = features(report);
    if (report.type === 'lost') {
      lostItems.push(item);
      continue;
    }
    for (const word of item.words) {
      if (!foundByWord.has(word)) foundByWord.set(word, []);
      foundByWord.get(word).push(item);
    }
  }
  for (const lost of lostItems) {
    const candidates = new Set();
    for (const word of lost.words) {
      for (const found of foundByWord.get(word) || []) candidates.add(found);
    }
    for (const found of candidates) {
      const result = scoreFeatures(lost, found);
      if (result.score < 50 || result.reasons.length < 2) continue;
      if (matches.length === capacity && result.score <= matches[capacity - 1].score) continue;
      const index = matches.findIndex(match => match.score < result.score);
      matches.splice(index < 0 ? matches.length : index, 0, {lost: lost.report, found: found.report, ...result});
      if (matches.length > capacity) matches.pop();
    }
  }
  return matches;
}

const matching = {tokenize, textSimilarity, dayDistance, scoreMatch, findMatches};
if (typeof module !== 'undefined') module.exports = matching;
if (typeof window !== 'undefined') window.FindItAlgorithms = matching;
