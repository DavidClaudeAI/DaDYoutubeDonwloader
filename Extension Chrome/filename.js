// Nom de fichier proposé à l'enregistrement, construit à partir du titre de
// la vidéo.
//
// Chrome et Brave refusent un nom qu'ils jugent dangereux : chrome.downloads
// rejette alors la demande avec « Invalid filename », et rien n'est
// téléchargé. Leurs règles (Chromium, IsSafePortablePathComponent) refusent :
// les caractères " ~ * / : < > ? \ |, les caractères de contrôle et les
// caractères invisibles de mise en forme (espaces sans largeur, marques de
// sens d'écriture…), un nom qui commence ou finit par un point ou une espace,
// les noms réservés de Windows (CON, NUL, COM1…), et une moitié d'emoji
// laissée par une coupe au milieu d'un caractère.
//
// Les titres YouTube contiennent régulièrement ces caractères : le nom est
// donc nettoyé de tout ce que ces règles refusent. Si le titre ne laisse rien
// d'utilisable, on retombe sur l'identifiant de la vidéo.

const MAX_TITLE_LENGTH = 100;
const FORBIDDEN_CHARACTERS = /[<>:"/\\|?*~]|\p{Cc}|\p{Cf}/gu;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function safeBaseName(title, videoId) {
  const cleaned = String(title ?? '')
    .replace(FORBIDDEN_CHARACTERS, '')
    .replace(/\s+/g, '_');

  // Couper par caractère et non par unité de code : `substring` peut
  // séparer les deux moitiés d'un emoji, et une moitié seule est refusée.
  const shortened = Array.from(cleaned).slice(0, MAX_TITLE_LENGTH).join('');

  // Ni point ni soulignement aux extrémités : un point final est refusé, et
  // les soulignements viennent d'espaces qui l'étaient aussi.
  const trimmed = shortened.replace(/^[._]+|[._]+$/g, '');

  if (trimmed === '' || WINDOWS_RESERVED_NAMES.test(trimmed)) {
    return fallbackBaseName(videoId);
  }
  return trimmed;
}

// Nom de secours, fait uniquement de caractères sûrs.
function fallbackBaseName(videoId) {
  const id = String(videoId ?? '').replace(/[^A-Za-z0-9_-]/g, '');
  return id ? `youtube_${id}` : 'youtube_video';
}

if (typeof module !== 'undefined') {
  module.exports = { safeBaseName, fallbackBaseName };
}
