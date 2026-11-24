// Tests du nom de fichier proposé à l'enregistrement.
// Lancer : node --test
const test = require('node:test');
const assert = require('node:assert/strict');
const { safeBaseName, fallbackBaseName } = require('../Extension Chrome/filename.js');

// Ce que Chromium refuse dans un nom de fichier (IsSafePortablePathComponent).
function chromiumWouldRefuse(name) {
  return /[<>:"/\\|?*~]|\p{Cc}|\p{Cf}/u.test(name)
    || /^[\s.]|[\s.]$/.test(name)
    || /\p{Cs}/u.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(name);
}

test('le titre de la vidéo du 24/11 donne un nom accepté', () => {
  const name = safeBaseName('Meet Wild Hornets - Ukrainian FPV Manufacture | @69thSniffingBrigade', 'ZFtY0ZWHlec');
  assert.equal(name, 'Meet_Wild_Hornets_-_Ukrainian_FPV_Manufacture_@69thSniffingBrigade');
  assert.equal(chromiumWouldRefuse(name), false);
});

test('le tilde, refusé par Chromium, est retiré', () => {
  assert.equal(safeBaseName('FPV ~ freestyle', 'x'), 'FPV_freestyle');
});

test('les caractères invisibles sont retirés', () => {
  const name = safeBaseName('Drone\u200B\u200Ftest\u2066 fin', 'x');
  assert.equal(name, 'Dronetest_fin');
});

test('un point final est retiré', () => {
  assert.equal(safeBaseName('Episode 12...', 'x'), 'Episode_12');
  assert.equal(safeBaseName('...caché', 'x'), 'caché');
});

test('la coupe à 100 caractères ne sépare jamais un emoji', () => {
  const title = 'a'.repeat(99) + '🚁🚁';
  const name = safeBaseName(title, 'x');
  assert.equal(Array.from(name).length, 100);
  assert.equal(chromiumWouldRefuse(name), false);
});

test('un titre vide ou fait de caractères interdits donne le nom de secours', () => {
  assert.equal(safeBaseName('', 'ZFtY0ZWHlec'), 'youtube_ZFtY0ZWHlec');
  assert.equal(safeBaseName('|||???', 'ZFtY0ZWHlec'), 'youtube_ZFtY0ZWHlec');
  assert.equal(safeBaseName(undefined, undefined), 'youtube_video');
});

test('un nom réservé de Windows donne le nom de secours', () => {
  assert.equal(safeBaseName('CON', 'abc'), 'youtube_abc');
  assert.equal(safeBaseName('nul', 'abc'), 'youtube_abc');
});

test('le nom de secours ne garde que des caractères sûrs', () => {
  assert.equal(fallbackBaseName('ab/c..d'), 'youtube_abcd');
});

test('des titres variés donnent toujours un nom accepté', () => {
  const titles = [
    'Ми сидимо в окопі | Пілоти БПЛА',
    'Test: "quotes" <tags> & more?',
    '  espaces autour  ',
    '\u202Eà l\'envers',
    'Tabulation\tet\nretour',
  ];
  for (const title of titles) {
    const name = safeBaseName(title, 'id');
    assert.equal(chromiumWouldRefuse(name), false, `${JSON.stringify(title)} → ${JSON.stringify(name)}`);
  }
});
