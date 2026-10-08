const express = require('express');
const cors = require('cors');
const { execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');

// execFile passe les arguments tels quels au programme, sans shell : un
// identifiant de vidéo venant de l'extension ne peut plus être interprété
// comme une commande, et les caractères spéciaux n'ont plus besoin d'être
// échappés à la main.
const execFileAsync = promisify(execFile);

const app = express();
const PORT = 3010;

// Configuration CORS pour permettre l'extension Chrome
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json());

// Dossier pour stocker temporairement les vidéos téléchargées
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR);
}

// Chemin vers yt-dlp
const YTDLP_PATH = path.join(__dirname, 'yt-dlp.exe');

// ffmpeg et ffprobe sont pris dans le PATH, comme le fait yt-dlp pour sa fusion.
const FFMPEG = 'ffmpeg';
const FFPROBE = 'ffprobe';

// Chemin vers le fichier de cookies (optionnel)
const COOKIES_PATH = path.join(__dirname, 'cookies.txt');
const USE_COOKIES = fs.existsSync(COOKIES_PATH);

// User-Agent Chrome moderne pour éviter la détection de bot
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// Runtime JS pour yt-dlp (nécessaire pour résoudre les challenges YouTube)
const JS_RUNTIME = 'node';

// Champs réellement utilisés par le serveur, demandés à yt-dlp sous forme de
// JSON filtré (`--print`). `--dump-json` renvoyait TOUT le dossier de la vidéo
// — dont les sous-titres automatiques dans ~160 langues, soit plus d'un millier
// d'URLs — et dépassait la mémoire tampon d'exec() ("stdout maxBuffer length
// exceeded"), indépendamment de la durée de la vidéo. Ici la sortie tient en
// quelques centaines d'octets : le problème ne peut plus se reproduire.
const INFO_FIELDS = '%(.{title,duration,thumbnail})j';

// Plafond de résolution : la 4K, résolution de montage. Au-delà (8K), les
// fichiers sont énormes sans rien apporter à un montage 4K.
const MAX_HEIGHT = 2160;

// Choix du format. Dans chaque alternative, yt-dlp prend la plus haute
// résolution sous le plafond, puis, à résolution égale, son ordre de codecs
// par défaut : AV1 > VP9 > H.265 > H.264. L'AV1 est donc pris quand YouTube
// le propose, ce qui est le cas idéal pour Resolve (voir prepareForResolve).
// Les versions SDR passent avant les HDR : YouTube fournit toujours une
// version SDR des vidéos HDR, et son AV1 HDR est en 10 bits, que Resolve ne
// décode pas sur la carte graphique (seul l'AV1 8 bits l'est).
const FORMAT_SELECTOR =
  `bv*[height<=${MAX_HEIGHT}][dynamic_range=SDR]+ba` +
  `/bv*[height<=${MAX_HEIGHT}]+ba` +
  `/b[height<=${MAX_HEIGHT}]/b`;

// Repli quand YouTube refuse les flux séparés (nsig, SABR, 403) : un fichier
// unique déjà fusionné, de qualité souvent moindre.
const FALLBACK_SELECTOR = `b[height<=${MAX_HEIGHT}]/b`;

// Arguments de la requête d'informations, partagés par tous les appels.
function infoArgs(videoUrl) {
  return [
    ...(USE_COOKIES ? ['--cookies', COOKIES_PATH] : []),
    '--js-runtimes', JS_RUNTIME,
    '--user-agent', USER_AGENT,
    '--print', INFO_FIELDS,
    '--skip-download',
    videoUrl
  ];
}

// Queue des téléchargements
const downloadQueue = new Map(); // downloadId -> { status, progress, message, filePath, filename, urlFilePath, error }

// Met à jour une entrée de la queue en gardant les champs non précisés.
function updateDownload(downloadId, fields) {
  downloadQueue.set(downloadId, { ...downloadQueue.get(downloadId), ...fields });
}

function sanitizeTitle(title) {
  return title.replace(/[<>:"/\\|?*]/g, '_');
}

// Endpoint pour obtenir les informations de la vidéo
app.get('/api/video-info/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    console.log(`Fetching info for: ${videoUrl}`);

    const { stdout } = await execFileAsync(YTDLP_PATH, infoArgs(videoUrl), {
      maxBuffer: 10 * 1024 * 1024
    });

    const data = JSON.parse(stdout);

    res.json({
      success: true,
      data: {
        title: data.title,
        duration: data.duration,
        thumbnail: data.thumbnail
      }
    });

  } catch (error) {
    console.error('Error fetching video info:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint pour démarrer un téléchargement (non-bloquant)
app.post('/api/download/start', async (req, res) => {
  try {
    const { videoId } = req.body;
    const downloadId = `${videoId}_${Date.now()}`;

    console.log(`Starting download: ${downloadId}`);

    downloadQueue.set(downloadId, {
      status: 'queued',
      progress: 0,
      message: 'En attente...',
      filePath: null,
      error: null
    });

    // Retourner immédiatement le downloadId au client
    res.json({ success: true, downloadId });

    // Démarrer le téléchargement en arrière-plan
    processDownload(downloadId, videoId).catch(error => {
      console.error(`Download ${downloadId} failed:`, error);
    });

  } catch (error) {
    console.error('Error starting download:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Fonction pour créer un fichier raccourci .url Windows
function createUrlShortcut(downloadId, videoId) {
  const urlContent = `[InternetShortcut]\r\nURL=https://www.youtube.com/watch?v=${videoId}\r\n`;
  const urlFilePath = path.join(DOWNLOAD_DIR, `${downloadId}.url`);

  fs.writeFileSync(urlFilePath, urlContent, 'utf8');
  console.log(`Created URL shortcut: ${urlFilePath}`);

  return urlFilePath;
}

// Télécharge la vidéo avec un sélecteur de format donné. yt-dlp choisit
// l'extension du fichier (mkv quand il fusionne, sinon celle du flux unique) :
// le chemin réellement écrit est relu sur sa sortie (`--print after_move:filepath`).
async function downloadWithFormat(downloadId, videoUrl, formatSelector, attemptNumber) {
  return new Promise((resolve, reject) => {
    const args = [];

    if (USE_COOKIES) {
      args.push('--cookies', COOKIES_PATH);
    }

    args.push('--js-runtimes', JS_RUNTIME);
    args.push('--user-agent', USER_AGENT);
    args.push('--sleep-requests', '1');

    args.push(
      '-f', formatSelector,
      // Le mkv accepte tous les codecs ; le fichier final .mp4 est produit
      // ensuite par prepareForResolve.
      '--merge-output-format', 'mkv',
      '--fixup', 'detect_or_warn',
      '--newline',
      '--progress',
      '--print', 'after_move:filepath',
      // Sans cela, yt-dlp écrit dans la page de code de la console Windows :
      // le « é » de « vidéo » dans le chemin du dossier arrive illisible et
      // le fichier n'est pas retrouvé.
      '--encoding', 'utf-8',
      '-o', path.join(DOWNLOAD_DIR, `${downloadId}.source.%(ext)s`),
      videoUrl
    );

    const ytdlp = spawn(YTDLP_PATH, args);
    console.log(`[${downloadId}] yt-dlp process started (attempt ${attemptNumber})`);

    let stderrData = '';
    let stdoutData = '';

    const parseProgress = (output) => {
      if (output.includes('ERROR')) {
        console.error(`[${downloadId}] yt-dlp ERROR:`, output);
      }

      const downloadMatch = output.match(/\[download\]\s+(\d+\.?\d*)%/);
      if (downloadMatch) {
        const percentage = parseFloat(downloadMatch[1]);
        updateDownload(downloadId, {
          progress: percentage,
          message: attemptNumber > 1 ? 'Téléchargement (qualité adaptée)' : 'Téléchargement en cours'
        });
      }

      if (output.includes('Merging formats') || output.includes('[Merger]')) {
        updateDownload(downloadId, { progress: 100, message: 'Fusion vidéo + audio...' });
        console.log(`[${downloadId}] Merging formats...`);
      }
    };

    ytdlp.stdout.on('data', (data) => {
      const output = data.toString();
      stdoutData += output;
      parseProgress(output);
    });

    ytdlp.stderr.on('data', (data) => {
      const output = data.toString();
      stderrData += output;
      parseProgress(output);
    });

    ytdlp.on('close', (code) => {
      console.log(`[${downloadId}] yt-dlp process exited with code ${code}`);
      if (code === 0) {
        // Dernière ligne non vide de stdout = chemin du fichier final.
        const lines = stdoutData.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const filePath = lines[lines.length - 1];
        if (!filePath || !fs.existsSync(filePath)) {
          reject(new Error('yt-dlp a terminé sans fichier lisible.'));
          return;
        }
        resolve({ success: true, filePath });
        return;
      }

      console.error(`[${downloadId}] Download failed with code ${code}`);
      console.error('Full stderr output:', stderrData);

      // Détecter si c'est une erreur nsig ou SABR qui justifie un fallback
      const isNsigError = stderrData.includes('nsig extraction failed');
      const isSabrError = stderrData.includes('SABR streaming') || stderrData.includes('forcing SABR');
      const is403Error = stderrData.includes('HTTP Error 403') || stderrData.includes('Forbidden');

      if ((isNsigError || isSabrError || is403Error) && attemptNumber === 1) {
        console.log(`[${downloadId}] ⚠️ Format quality issue detected, fallback recommended`);
        resolve({ success: false, shouldFallback: true });
      } else if (isSabrError) {
        reject(new Error('YouTube force le SABR streaming pour cette vidéo. Veuillez mettre à jour yt-dlp avec la commande: yt-dlp.exe -U'));
      } else if (is403Error) {
        reject(new Error('HTTP 403: YouTube bloque le téléchargement. Solution: 1) Mettez à jour yt-dlp avec "yt-dlp.exe -U" 2) Videz le cache avec "yt-dlp.exe --rm-cache-dir" 3) Rafraîchissez vos cookies YouTube si le problème persiste.'));
      } else if (stderrData.includes('Sign in to confirm') || stderrData.includes('not a bot')) {
        reject(new Error('Sign in to confirm you\'re not a bot. Toutes les méthodes de contournement ont échoué. Attendez quelques minutes avant de réessayer.'));
      } else {
        reject(new Error(`yt-dlp exited with code ${code}. Check server logs for details.`));
      }
    });

    ytdlp.on('error', (error) => {
      console.error(`[${downloadId}] yt-dlp spawn error:`, error);
      reject(error);
    });
  });
}

// Supprime les fichiers sources laissés par yt-dlp pour ce téléchargement
// (fichier fusionné, ou morceaux .part d'une tentative interrompue).
function removeSourceFiles(downloadId) {
  for (const name of fs.readdirSync(DOWNLOAD_DIR)) {
    if (name.startsWith(`${downloadId}.source.`)) {
      fs.rmSync(path.join(DOWNLOAD_DIR, name), { force: true });
    }
  }
}

async function probeStreams(filePath) {
  const { stdout } = await execFileAsync(FFPROBE, [
    '-v', 'error',
    '-show_entries', 'stream=codec_type,codec_name,pix_fmt',
    '-of', 'json',
    filePath
  ]);
  const streams = JSON.parse(stdout).streams || [];
  return {
    video: streams.find(s => s.codec_type === 'video'),
    audio: streams.find(s => s.codec_type === 'audio')
  };
}

// Décide ce qu'il faut faire de la vidéo pour que DaVinci Resolve la lise
// sans « média manquant ». Constaté sur Resolve 21.1 / RTX 3080 Ti
// (journal davinci_resolve.log) :
// - H.264, HEVC et AV1 8 bits : lus sans erreur → copiés tels quels ;
// - VP9 : échecs de décodage répétés sur l'image précédant chaque image clé
//   (« Failed to decode the video frame ») → convertis en HEVC ;
// - AV1 10 bits : non pris en charge par le décodeur de la carte selon
//   Resolve → convertis en HEVC 10 bits.
function videoPlan(video) {
  const tenBit = /10/.test(video.pix_fmt || '');
  if (video.codec_name === 'h264' || video.codec_name === 'hevc') {
    return { copy: true };
  }
  if (video.codec_name === 'av1' && !tenBit) {
    return { copy: true };
  }
  return { copy: false, tenBit, from: video.codec_name.toUpperCase() };
}

// Produit le fichier final .mp4 : vidéo copiée ou convertie en HEVC par la
// carte graphique (NVENC), son converti en AAC (Resolve gère mal l'Opus dans
// un .mp4). La progression de ffmpeg (`-progress pipe:1`) alimente la barre
// de l'extension.
async function prepareForResolve(downloadId, sourcePath, finalPath, durationSec) {
  const { video, audio } = await probeStreams(sourcePath);
  if (!video) {
    throw new Error('Le fichier téléchargé ne contient pas de vidéo.');
  }

  const plan = videoPlan(video);
  const args = ['-y', '-hide_banner', '-v', 'error', '-i', sourcePath, '-map', '0:v:0'];
  if (audio) {
    args.push('-map', '0:a:0');
  }

  if (plan.copy) {
    args.push('-c:v', 'copy');
  } else {
    args.push(
      '-c:v', 'hevc_nvenc',
      '-preset', 'p6',
      '-tune', 'hq',
      '-rc', 'vbr',
      '-cq', '19',
      '-b:v', '0',
      '-pix_fmt', plan.tenBit ? 'p010le' : 'yuv420p',
      '-profile:v', plan.tenBit ? 'main10' : 'main',
      // Repère « hvc1 » attendu par les lecteurs pour du HEVC dans un .mp4.
      '-tag:v', 'hvc1'
    );
  }

  if (audio) {
    if (audio.codec_name === 'aac') {
      args.push('-c:a', 'copy');
    } else {
      args.push('-c:a', 'aac', '-b:a', '320k');
    }
  }

  args.push('-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', finalPath);

  const message = plan.copy
    ? 'Préparation du fichier...'
    : `Conversion pour Resolve (${plan.from} → HEVC)...`;
  updateDownload(downloadId, { status: 'converting', progress: 0, message });
  console.log(`[${downloadId}] ${message} video=${video.codec_name}/${video.pix_fmt} audio=${audio ? audio.codec_name : 'aucun'}`);

  await new Promise((resolve, reject) => {
    const ffmpeg = spawn(FFMPEG, args);
    let stderrData = '';

    ffmpeg.stdout.on('data', (data) => {
      const match = data.toString().match(/out_time_us=(\d+)/);
      if (match && durationSec > 0) {
        const percentage = Math.min(100, Number(match[1]) / 1e6 / durationSec * 100);
        updateDownload(downloadId, { progress: percentage });
      }
    });

    ffmpeg.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    ffmpeg.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        console.error(`[${downloadId}] ffmpeg failed with code ${code}:`, stderrData);
        reject(new Error(`La conversion du fichier a échoué (ffmpeg ${code}) : ${stderrData.trim().split(/\r?\n/).pop() || 'voir les journaux du serveur'}`));
      }
    });

    ffmpeg.on('error', (error) => {
      reject(new Error(`ffmpeg introuvable ou impossible à lancer : ${error.message}`));
    });
  });
}

// Fonction de traitement du téléchargement en arrière-plan
async function processDownload(downloadId, videoId) {
  const finalPath = path.join(DOWNLOAD_DIR, `${downloadId}.mp4`);

  try {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    updateDownload(downloadId, {
      status: 'fetching_info',
      progress: 0,
      message: 'Récupération des informations...'
    });

    console.log(`[${downloadId}] Fetching video info...`);
    const { stdout: infoJson } = await execFileAsync(YTDLP_PATH, infoArgs(videoUrl), {
      maxBuffer: 10 * 1024 * 1024
    });
    const videoInfo = JSON.parse(infoJson);
    const sanitizedTitle = sanitizeTitle(videoInfo.title);

    updateDownload(downloadId, {
      status: 'downloading',
      progress: 0,
      message: 'Téléchargement en cours...'
    });

    console.log(`[${downloadId}] Attempt 1: Trying format ${FORMAT_SELECTOR}`);
    let result = await downloadWithFormat(downloadId, videoUrl, FORMAT_SELECTOR, 1);

    if (!result.success && result.shouldFallback) {
      console.log(`[${downloadId}] ⚠️ First attempt failed with nsig/SABR error, falling back to ${FALLBACK_SELECTOR}`);
      removeSourceFiles(downloadId);

      updateDownload(downloadId, {
        status: 'downloading',
        progress: 0,
        message: 'Nouvelle tentative avec qualité adaptée...'
      });

      result = await downloadWithFormat(downloadId, videoUrl, FALLBACK_SELECTOR, 2);
    }

    if (!result.success) {
      throw new Error('Download failed after fallback attempts');
    }

    await prepareForResolve(downloadId, result.filePath, finalPath, videoInfo.duration);
    removeSourceFiles(downloadId);

    const stat = fs.statSync(finalPath);
    if (stat.size < 1000) {
      throw new Error('Downloaded file appears to be corrupted or incomplete');
    }

    console.log(`Download ${downloadId} complete: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);

    const urlFilePath = createUrlShortcut(downloadId, videoId);

    updateDownload(downloadId, {
      status: 'ready',
      progress: 100,
      message: 'Téléchargement terminé',
      filePath: finalPath,
      filename: `${sanitizedTitle}.mp4`,
      urlFilePath,
      urlFilename: `${sanitizedTitle}.url`,
      error: null
    });

  } catch (error) {
    console.error(`Error processing download ${downloadId}:`, error);

    removeSourceFiles(downloadId);
    fs.rmSync(finalPath, { force: true });

    updateDownload(downloadId, {
      status: 'error',
      progress: 0,
      message: error.message,
      filePath: null,
      error: error.message
    });

    throw error;
  }
}

// Endpoint pour vérifier le statut d'un téléchargement
app.get('/api/download/status/:downloadId', (req, res) => {
  const { downloadId } = req.params;
  const download = downloadQueue.get(downloadId);

  if (!download) {
    return res.status(404).json({
      success: false,
      error: 'Download not found'
    });
  }

  res.json({
    success: true,
    status: download.status,
    progress: download.progress,
    message: download.message,
    error: download.error
  });
});

// Endpoint pour récupérer le fichier téléchargé
app.get('/api/download/file/:downloadId', (req, res) => {
  const { downloadId } = req.params;
  const download = downloadQueue.get(downloadId);

  if (!download) {
    return res.status(404).json({
      success: false,
      error: 'Download not found'
    });
  }

  if (download.status !== 'ready') {
    return res.status(400).json({
      success: false,
      error: `Download not ready. Current status: ${download.status}`
    });
  }

  const filePath = download.filePath;
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({
      success: false,
      error: 'File not found'
    });
  }

  const stat = fs.statSync(filePath);

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(download.filename)}"`);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stat.size);

  const fileStream = fs.createReadStream(filePath);
  fileStream.pipe(res);

  // Supprimer le fichier après l'envoi
  fileStream.on('end', () => {
    console.log(`File sent to client, deleting: ${filePath}`);
    fs.rmSync(filePath, { force: true });
    downloadQueue.delete(downloadId);
  });

  fileStream.on('error', (error) => {
    console.error('File stream error:', error);
    fs.rmSync(filePath, { force: true });
    downloadQueue.delete(downloadId);
  });

  res.on('close', () => {
    fileStream.destroy();
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
      console.log('Client disconnected, deleted temporary file');
    }
    downloadQueue.delete(downloadId);
  });
});

// Endpoint pour récupérer le fichier raccourci .url
app.get('/api/download/url/:downloadId', (req, res) => {
  const { downloadId } = req.params;
  const download = downloadQueue.get(downloadId);

  if (!download) {
    return res.status(404).json({
      success: false,
      error: 'Download not found'
    });
  }

  if (download.status !== 'ready') {
    return res.status(400).json({
      success: false,
      error: `Download not ready. Current status: ${download.status}`
    });
  }

  const urlFilePath = download.urlFilePath;
  if (!urlFilePath || !fs.existsSync(urlFilePath)) {
    return res.status(404).json({
      success: false,
      error: 'URL shortcut file not found'
    });
  }

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(download.urlFilename)}"`);
  res.setHeader('Content-Type', 'text/plain');

  const fileContent = fs.readFileSync(urlFilePath, 'utf8');
  res.send(fileContent);

  // Supprimer le fichier .url après l'envoi
  console.log(`URL shortcut sent to client, deleting: ${urlFilePath}`);
  fs.rmSync(urlFilePath, { force: true });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'YouTube Downloader Backend is running' });
});

// Vider le cache yt-dlp au démarrage pour éviter les problèmes de signatures obsolètes
async function clearYtdlpCache() {
  try {
    console.log('🧹 Clearing yt-dlp cache...');
    await execFileAsync(YTDLP_PATH, ['--rm-cache-dir']);
    console.log('✓ yt-dlp cache cleared');
  } catch (error) {
    console.warn('⚠️  Could not clear yt-dlp cache:', error.message);
  }
}

app.listen(PORT, async () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
  console.log(`📁 Download directory: ${DOWNLOAD_DIR}`);
  console.log(`🎬 Using yt-dlp: ${YTDLP_PATH}`);

  // Vider le cache au démarrage
  await clearYtdlpCache();

  if (USE_COOKIES) {
    console.log(`🍪 Using cookies from: ${COOKIES_PATH}`);
  } else {
    console.log(`⚠️  No cookies file found at: ${COOKIES_PATH}`);
    console.log(`   Si YouTube bloque les téléchargements, exportez vos cookies YouTube dans ce fichier.`);
    console.log(`   Utilisez l'extension Chrome "Get cookies.txt LOCALLY" pour exporter les cookies.`);
  }
});
