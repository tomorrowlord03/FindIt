import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {test} from 'node:test';

const require = createRequire(import.meta.url);
const {tokenize, textSimilarity, dayDistance, scoreMatch, findMatches} = require('./algorithms.js');
const lost = {id:'L-1', type:'lost', category:'Electronics', color:'Black', location:'Library',
  date:'2026-09-12', title:'wireless earphones', description:'black bluetooth earbuds'};
const found = {id:'F-1', type:'found', category:'Electronics', color:'Black', location:'Library',
  date:'2026-09-12', title:'black earbuds', description:'wireless earphones'};

test('campus synonyms, case, punctuation and Indian-script tokens', () => {
  assert.deepEqual(tokenize('Black, wireless earbuds!'), ['black','wireless','earphones']);
  assert.deepEqual(tokenize('Bluetooth earbuds'), ['bluetooth','earphones']);
  assert.deepEqual(tokenize('मोबाइल ID'), ['मोबाइल','identity']);
  assert.equal(textSimilarity('black wireless earbuds','black wireless earbuds'), 1);
});

test('similar item details produce one strong, explained candidate', () => {
  const score = scoreMatch(lost,found);
  assert.ok(score.score >= 80);
  assert.ok(score.reasons.includes('similar item wording'));
  assert.deepEqual(findMatches([lost,found]), [{lost,found,...score}]);
});

test('generic category, location, date, and colour cannot create a suggestion alone', () => {
  const charger = {...lost,title:'white charger',description:'Found near library',color:'white'};
  const watch = {...found,title:'white watch',description:'Lost at library',color:'white'};
  assert.deepEqual(findMatches([charger,watch]), []);
});

test('unknown fields add no evidence and missing dates remain valid', () => {
  const a = {type:'lost',title:'Calculus notebook',category:'Books',color:'Unknown'};
  const b = {type:'found',title:'Calculus notebook',category:'Books',color:'unknown'};
  assert.deepEqual(scoreMatch(a,b).reasons, ['similar item wording','same category']);
  assert.equal(findMatches([a,b]).length, 1);
  assert.equal(dayDistance('2026-02-30','2026-03-01'), 999);
  assert.deepEqual(findMatches([{type:'lost'},{type:'found'}]), []);
});

test('claimed, returned, archived and distant reports stay out of the queue', () => {
  for (const status of ['Claimed','Returned','Archived','Closed']) {
    assert.deepEqual(findMatches([lost,{...found,status}]), []);
  }
  assert.equal(findMatches([{...lost,status:'Possible Match'},found]).length, 1);
  assert.deepEqual(findMatches([lost,{...found,date:'2026-11-12'}]), []);
});

test('orders by evidence, bounds result size, and keeps ties deterministic', () => {
  const weaker = {...found,color:'white', id:'weak'};
  const board = [lost,weaker,...Array.from({length:130}, (_,i) => ({...found,id:String(i)}))];
  const top = findMatches(board,{limit:2});
  assert.deepEqual(top.map(m => m.found.id), ['0','1']);
  assert.equal(findMatches(board).length,25);
  assert.equal(findMatches(board,{limit:101}).length,100);
  assert.deepEqual(findMatches(board,{limit:0}),[]);
});
