const express = require('express');
const cors = require('cors');
const { exec, execFile, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { promisify } = require('util');

const execAsync = promisify(exec);
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

// Stockage des progressions de téléchargement
const downloadProgress = new Map();

// Queue des téléchargements
const downloadQueue = new Map(); // downloadId -> { status, filePath, error, progress }

// Endpoint pour obtenir les informations de la vidéo
app.get('/api/video-info/:videoId', async (req, res) => {
  try {
    const { videoId } = req.params;
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    console.log(`Fetching info for: ${videoUrl}`);

    // Utiliser yt-dlp pour obtenir les informations
    const { stdout } = await execFileAsync(YTDLP_PATH, infoArgs(videoUrl), {
      maxBuffer: 10 * 1024 * 1024
    });

    const data = JSON.parse(stdout);

    // Qualités disponibles
    const availableQualities = ['2160p', '1440p', '1080p', '720p', '480p', '360p'];

    res.json({
      success: true,
      data: {
        title: data.title,
        duration: data.duration,
        thumbnail: data.thumbnail,
        formats: availableQualities.map(q => ({
          quality: q,
          resolution: q
        }))
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
    const { videoId, quality, title } = req.body;
    const downloadId = `${videoId}_${quality}_${Date.now()}`;

    console.log(`Starting download: ${downloadId}`);

    // Créer l'entrée dans la queue
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
    processDownload(downloadId, videoId, quality, title).catch(error => {
      console.error(`Download ${downloadId} failed:`, error);
      downloadQueue.set(downloadId, {
        status: 'error',
        progress: 0,
        message: error.message,
        filePath: null,
        error: error.message
      });
    });

  } catch (error) {
    console.error('Error starting download:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Fonction pour créer un fichier raccourci .url Windows
function createUrlShortcut(videoId, sanitizedTitle) {
  const urlContent = `[InternetShortcut]\r\nURL=https://www.youtube.com/watch?v=${videoId}\r\n`;
  const urlFileName = `${sanitizedTitle}.url`;
  const urlFilePath = path.join(DOWNLOAD_DIR, urlFileName);

  fs.writeFileSync(urlFilePath, urlContent, 'utf8');
  console.log(`Created URL shortcut: ${urlFilePath}`);

  return urlFilePath;
}

// Fonction auxiliaire pour télécharger avec un format donné
async function downloadWithFormat(downloadId, videoUrl, tempFilePath, formatSelector, attemptNumber) {
  return new Promise((resolve, reject) => {
    const args = [];

    // Ajouter les cookies si disponibles
    if (USE_COOKIES) {
      args.push('--cookies', COOKIES_PATH);
    }

    // Ajouter runtime JS et User-Agent
    args.push('--js-runtimes', JS_RUNTIME);
    args.push('--user-agent', USER_AGENT);
    args.push('--sleep-requests', '1');

    args.push(
      '-f', formatSelector,
      '--merge-output-format', 'mp4',
      '--fixup', 'detect_or_warn',
      '--postprocessor-args', 'ffmpeg:-movflags +faststart -fflags +genpts',
      '--newline',
      '--progress',
      '-o', tempFilePath,
      videoUrl
    );

    const ytdlp = spawn(YTDLP_PATH, args);
    console.log(`[${downloadId}] yt-dlp process started (attempt ${attemptNumber})`);

    let stderrData = '';

    // Fonction pour parser la progression
    const parseProgress = (output) => {
      if (output.includes('ERROR')) {
        console.error(`[${downloadId}] yt-dlp ERROR:`, output);
      }

      const downloadMatch = output.match(/\[download\]\s+(\d+\.?\d*)%/);
      if (downloadMatch) {
        const percentage = parseFloat(downloadMatch[1]);
        const currentQueue = downloadQueue.get(downloadId);
        if (currentQueue) {
          downloadQueue.set(downloadId, {
            ...currentQueue,
            progress: percentage,
            message: attemptNumber > 1 ? 'Téléchargement (qualité adaptée)' : 'Téléchargement en cours'
          });
          console.log(`[${downloadId}] Progress: ${percentage.toFixed(1)}%`);
        }
      }

      if (output.includes('Merging formats') || output.includes('[Merger]')) {
        const currentQueue = downloadQueue.get(downloadId);
        if (currentQueue) {
          downloadQueue.set(downloadId, {
            ...currentQueue,
            progress: 95,
            message: 'Fusion vidéo + audio...'
          });
          console.log(`[${downloadId}] Merging formats...`);
        }
      }
    };

    // Écouter stdout (progression avec --progress --newline)
    ytdlp.stdout.on('data', (data) => {
      const output = data.toString();
      parseProgress(output);
    });

    // Écouter stderr (messages d'erreur et informations)
    ytdlp.stderr.on('data', (data) => {
      const output = data.toString();
      stderrData += output;
      parseProgress(output);
    });

    ytdlp.on('close', (code) => {
      console.log(`[${downloadId}] yt-dlp process exited with code ${code}`);
      if (code === 0) {
        console.log(`[${downloadId}] ✓ Download successful`);
        resolve({ success: true });
      } else {
        console.error(`[${downloadId}] Download failed with code ${code}`);

        // Détecter si c'est une erreur nsig ou SABR qui justifie un fallback
        const isNsigError = stderrData.includes('nsig extraction failed');
        const isSabrError = stderrData.includes('SABR streaming') || stderrData.includes('forcing SABR');
        const is403Error = stderrData.includes('HTTP Error 403') || stderrData.includes('Forbidden');

        if ((isNsigError || isSabrError || is403Error) && attemptNumber === 1) {
          console.log(`[${downloadId}] ⚠️ Format quality issue detected, fallback recommended`);
          console.error('Full stderr output:', stderrData);
          resolve({ success: false, shouldFallback: true, stderr: stderrData });
        } else {
          // Erreur finale ou autre type d'erreur
          console.error('Full stderr output:', stderrData);

          if (isSabrError) {
            reject(new Error('YouTube force le SABR streaming pour cette vidéo. Veuillez mettre à jour yt-dlp avec la commande: yt-dlp.exe -U'));
          } else if (is403Error) {
            reject(new Error('HTTP 403: YouTube bloque le téléchargement. La qualité demandée n\'est pas disponible.'));
          } else if (stderrData.includes('Sign in to confirm') || stderrData.includes('not a bot')) {
            reject(new Error('Sign in to confirm you\'re not a bot. Toutes les méthodes de contournement ont échoué. Attendez quelques minutes avant de réessayer.'));
          } else {
            reject(new Error(`yt-dlp exited with code ${code}. Check server logs for details.`));
          }
        }
      }
    });

    ytdlp.on('error', (error) => {
      console.error(`[${downloadId}] yt-dlp spawn error:`, error);
      reject(error);
    });
  });
}

// Fonction de traitement du téléchargement en arrière-plan
async function processDownload(downloadId, videoId, quality, title) {
  let tempFilePath = null;

  try {
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    // Mettre à jour le statut
    downloadQueue.set(downloadId, {
      status: 'fetching_info',
      progress: 0,
      message: 'Récupération des informations...',
      filePath: null,
      error: null
    });

    // Obtenir le titre de la vidéo
    console.log(`[${downloadId}] Fetching video info...`);
    const { stdout: infoJson } = await execFileAsync(YTDLP_PATH, infoArgs(videoUrl), {
      maxBuffer: 10 * 1024 * 1024
    });

    console.log(`[${downloadId}] Video info received, parsing...`);
    const videoInfo = JSON.parse(infoJson);
    const sanitizedTitle = videoInfo.title.replace(/[<>:"/\\|?*]/g, '_');
    const filename = `${downloadId}_${sanitizedTitle}.mp4`;
    tempFilePath = path.join(DOWNLOAD_DIR, filename);

    console.log(`[${downloadId}] Downloading to ${tempFilePath}`);

    const qualityHeight = quality.replace('p', '');
    let formatSelector = `bestvideo*[height<=${qualityHeight}]+bestaudio/best[height<=${qualityHeight}]/best`;

    // Mettre à jour le statut
    downloadQueue.set(downloadId, {
      status: 'downloading',
      progress: 0,
      message: 'Téléchargement en cours...',
      filePath: tempFilePath,
      error: null
    });

    // Première tentative avec le format demandé
    console.log(`[${downloadId}] Attempt 1: Trying format ${formatSelector}`);
    let result = await downloadWithFormat(downloadId, videoUrl, tempFilePath, formatSelector, 1);

    // Si échec avec fallback recommandé, essayer avec format "best"
    if (!result.success && result.shouldFallback) {
      console.log(`[${downloadId}] ⚠️ First attempt failed with nsig/SABR error, falling back to 'best' format`);

      // Nettoyer le fichier partiel si existant
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }

      formatSelector = `best[height<=${qualityHeight}]/best`;
      console.log(`[${downloadId}] Attempt 2: Trying fallback format ${formatSelector}`);

      downloadQueue.set(downloadId, {
        status: 'downloading',
        progress: 0,
        message: 'Nouvelle tentative avec qualité adaptée...',
        filePath: tempFilePath,
        error: null
      });

      result = await downloadWithFormat(downloadId, videoUrl, tempFilePath, formatSelector, 2);
    }

    if (!result.success) {
      throw new Error('Download failed after fallback attempts');
    }

    // Vérifier que le fichier existe et a une taille correcte
    if (!fs.existsSync(tempFilePath)) {
      throw new Error('Downloaded file not found');
    }

    const stat = fs.statSync(tempFilePath);
    if (stat.size < 1000) {
      throw new Error('Downloaded file appears to be corrupted or incomplete');
    }

    console.log(`Download ${downloadId} complete: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);

    // Créer le fichier raccourci .url
    const urlFilePath = createUrlShortcut(videoId, sanitizedTitle);

    // Marquer comme prêt
    downloadQueue.set(downloadId, {
      status: 'ready',
      progress: 100,
      message: 'Téléchargement terminé',
      filePath: tempFilePath,
      urlFilePath: urlFilePath,
      error: null
    });

  } catch (error) {
    console.error(`Error processing download ${downloadId}:`, error);

    // Nettoyer le fichier temporaire en cas d'erreur
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }

    downloadQueue.set(downloadId, {
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
  const filename = path.basename(filePath).replace(/^[^_]+_[^_]+_\d+_/, ''); // Enlever le préfixe downloadId

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stat.size);

  const fileStream = fs.createReadStream(filePath);
  fileStream.pipe(res);

  // Supprimer le fichier après l'envoi
  fileStream.on('end', () => {
    console.log(`File sent to client, deleting: ${filePath}`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    downloadQueue.delete(downloadId);
  });

  fileStream.on('error', (error) => {
    console.error('File stream error:', error);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    downloadQueue.delete(downloadId);
  });

  res.on('close', () => {
    fileStream.destroy();
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
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

  const filename = path.basename(urlFilePath);

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader('Content-Type', 'text/plain');

  const fileContent = fs.readFileSync(urlFilePath, 'utf8');
  res.send(fileContent);

  // Supprimer le fichier .url après l'envoi
  console.log(`URL shortcut sent to client, deleting: ${urlFilePath}`);
  if (fs.existsSync(urlFilePath)) {
    fs.unlinkSync(urlFilePath);
  }
});

// ANCIEN ENDPOINT (gardé pour compatibilité, sera supprimé plus tard)
app.get('/api/stream/:videoId', async (req, res) => {
  let tempFilePath = null;
  const downloadId = `${req.params.videoId}_${Date.now()}`;

  try {
    const { videoId } = req.params;
    const quality = req.query.quality || '720p';
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    console.log(`Downloading ${videoUrl} at quality ${quality}`);

    // Initialiser la progression
    downloadProgress.set(downloadId, {
      status: 'fetching_info',
      percentage: 0,
      message: 'Récupération des informations...'
    });

    // Obtenir d'abord le titre de la vidéo
    const { stdout: infoJson } = await execFileAsync(YTDLP_PATH, infoArgs(videoUrl), {
      maxBuffer: 10 * 1024 * 1024
    });

    const videoInfo = JSON.parse(infoJson);
    const sanitizedTitle = videoInfo.title.replace(/[<>:"/\\|?*]/g, '_');
    const filename = `${sanitizedTitle}.mp4`;

    // Créer un nom de fichier temporaire unique
    tempFilePath = path.join(DOWNLOAD_DIR, `temp_${Date.now()}_${filename}`);

    console.log(`Downloading to temporary file: ${tempFilePath}`);

    // Sélecteur de format avec fallback automatique
    // Accepte tous les formats (mp4, webm, av1, m3u8) pour avoir accès à la 4K
    // YouTube utilise parfois SABR qui ne fournit que des formats m3u8
    const qualityHeight = quality.replace('p', '');
    const formatSelector = `bestvideo*[height<=${qualityHeight}]+bestaudio/best[height<=${qualityHeight}]/best`;

    console.log(`Using format selector: ${formatSelector} for quality ${quality}`);

    // Mettre à jour la progression
    downloadProgress.set(downloadId, {
      status: 'downloading',
      percentage: 0,
      message: 'Téléchargement en cours...'
    });

    // Télécharger la vidéo avec yt-dlp en utilisant spawn pour capturer la progression
    await new Promise((resolve, reject) => {
      const args = [];

      // Ajouter les cookies si disponibles
      if (USE_COOKIES) {
        args.push('--cookies', COOKIES_PATH);
      }

      // Ajouter User-Agent et options anti-blocage
      args.push('--user-agent', USER_AGENT);
      args.push('--sleep-requests', '1');

      args.push(
        '-f', formatSelector,
        '--merge-output-format', 'mp4',
        '--fixup', 'detect_or_warn',
        '--postprocessor-args', 'ffmpeg:-movflags +faststart -fflags +genpts',
        '--newline',
        '--progress',
        '-o', tempFilePath,
        videoUrl
      );

      const ytdlp = spawn(YTDLP_PATH, args);

      console.log(`[${downloadId}] yt-dlp process started`);

      let stderrData = '';

      // Fonction pour parser la progression
      const parseProgress = (output) => {
        if (output.includes('ERROR')) {
          console.error(`[${downloadId}] yt-dlp ERROR:`, output);
        }

        const downloadMatch = output.match(/\[download\]\s+(\d+\.?\d*)%/);
        if (downloadMatch) {
          const percentage = parseFloat(downloadMatch[1]);
          const currentQueue = downloadQueue.get(downloadId);
          if (currentQueue) {
            downloadQueue.set(downloadId, {
              ...currentQueue,
              progress: percentage,
              message: 'Téléchargement en cours'
            });
            console.log(`[${downloadId}] Progress: ${percentage.toFixed(1)}%`);
          }
        }

        if (output.includes('Merging formats') || output.includes('[Merger]')) {
          const currentQueue = downloadQueue.get(downloadId);
          if (currentQueue) {
            downloadQueue.set(downloadId, {
              ...currentQueue,
              progress: 95,
              message: 'Fusion vidéo + audio...'
            });
            console.log(`[${downloadId}] Merging formats...`);
          }
        }
      };

      // Écouter stdout (progression avec --progress --newline)
      ytdlp.stdout.on('data', (data) => {
        const output = data.toString();
        parseProgress(output);
      });

      // Écouter stderr (messages d'erreur et informations)
      ytdlp.stderr.on('data', (data) => {
        const output = data.toString();
        stderrData += output;
        parseProgress(output);
      });

      ytdlp.on('close', (code) => {
        console.log(`[${downloadId}] yt-dlp process exited with code ${code}`);
        if (code === 0) {
          console.log(`[${downloadId}] ✓ Download successful`);
          resolve();
        } else {
          console.error(`[${downloadId}] Download failed with code ${code}`);

          // Vérifier si c'est une erreur SABR streaming
          if (stderrData.includes('SABR streaming') || stderrData.includes('forcing SABR')) {
            console.error(`[${downloadId}] ⚠️ SABR streaming error - YouTube force un mode de streaming incompatible`);
            console.error('Full stderr output:', stderrData);
            reject(new Error('YouTube force le SABR streaming pour cette vidéo. Veuillez mettre à jour yt-dlp avec la commande: yt-dlp.exe -U'));
          }
          // Vérifier si c'est une erreur HTTP 403 Forbidden
          else if (stderrData.includes('HTTP Error 403') || stderrData.includes('Forbidden')) {
            console.error(`[${downloadId}] ⚠️ HTTP 403 Forbidden - YouTube bloque la requête`);
            console.error('Full stderr output:', stderrData);
            reject(new Error('HTTP 403: YouTube bloque le téléchargement. Solution: 1) Mettez à jour yt-dlp avec "yt-dlp.exe -U" 2) Videz le cache avec "yt-dlp.exe --rm-cache-dir" 3) Rafraîchissez vos cookies YouTube si le problème persiste.'));
          }
          // Vérifier si c'est une erreur de détection bot
          else if (stderrData.includes('Sign in to confirm') || stderrData.includes('not a bot')) {
            console.error(`[${downloadId}] ⚠️ Bot detection error - cookies may be expired or blocked`);
            console.error('Full stderr output:', stderrData);
            reject(new Error('Sign in to confirm you\'re not a bot. Toutes les méthodes de contournement ont échoué. Attendez quelques minutes avant de réessayer.'));
          } else {
            console.error('Full stderr output:', stderrData);
            reject(new Error(`yt-dlp exited with code ${code}. Check server logs for details.`));
          }
        }
      });

      ytdlp.on('error', (error) => {
        console.error(`[${downloadId}] yt-dlp spawn error:`, error);
        reject(error);
      });
    });

    // Vérifier que le fichier existe et a une taille correcte
    if (!fs.existsSync(tempFilePath)) {
      throw new Error('Downloaded file not found');
    }

    const stat = fs.statSync(tempFilePath);
    if (stat.size < 1000) {
      throw new Error('Downloaded file appears to be corrupted or incomplete');
    }

    console.log(`Download ${downloadId} complete: ${(stat.size / 1024 / 1024).toFixed(2)} MB`);

    // Marquer comme prêt
    downloadQueue.set(downloadId, {
      status: 'ready',
      progress: 100,
      message: 'Téléchargement terminé',
      filePath: tempFilePath,
      error: null
    });

  } catch (error) {
    console.error(`Error processing download ${downloadId}:`, error);

    // Nettoyer le fichier temporaire en cas d'erreur
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }

    downloadQueue.set(downloadId, {
      status: 'error',
      progress: 0,
      message: error.message,
      filePath: null,
      error: error.message
    });

    throw error;
  }
});

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
  const filename = path.basename(filePath).replace(/^[^_]+_[^_]+_\d+_/, ''); // Enlever le préfixe downloadId

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Length', stat.size);

  const fileStream = fs.createReadStream(filePath);
  fileStream.pipe(res);

  // Supprimer le fichier après l'envoi
  fileStream.on('end', () => {
    console.log(`File sent to client, deleting: ${filePath}`);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    downloadQueue.delete(downloadId);
  });

  fileStream.on('error', (error) => {
    console.error('File stream error:', error);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    downloadQueue.delete(downloadId);
  });

  res.on('close', () => {
    fileStream.destroy();
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
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

  const filename = path.basename(urlFilePath);

  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.setHeader('Content-Type', 'text/plain');

  const fileContent = fs.readFileSync(urlFilePath, 'utf8');
  res.send(fileContent);

  // Supprimer le fichier .url après l'envoi
  console.log(`URL shortcut sent to client, deleting: ${urlFilePath}`);
  if (fs.existsSync(urlFilePath)) {
    fs.unlinkSync(urlFilePath);
  }
});

// ANCIEN ENDPOINT (gardé pour compatibilité, sera supprimé plus tard)
app.get('/api/stream/:videoId', async (req, res) => {
  let tempFilePath = null;
  const downloadId = `${req.params.videoId}_${Date.now()}`;

  try {
    const { videoId } = req.params;
    const quality = req.query.quality || '720p';
    const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;

    console.log(`Downloading ${videoUrl} at quality ${quality}`);

    // Initialiser la progression
    downloadProgress.set(downloadId, {
      status: 'fetching_info',
      percentage: 0,
      message: 'Récupération des informations...'
    });

    // Obtenir d'abord le titre de la vidéo
    const { stdout: infoJson } = await execFileAsync(YTDLP_PATH, infoArgs(videoUrl), {
      maxBuffer: 10 * 1024 * 1024
    });

    const videoInfo = JSON.parse(infoJson);
    const sanitizedTitle = videoInfo.title.replace(/[<>:"/\\|?*]/g, '_');
    const filename = `${sanitizedTitle}.mp4`;

    // Créer un nom de fichier temporaire unique
    tempFilePath = path.join(DOWNLOAD_DIR, `temp_${Date.now()}_${filename}`);

    console.log(`Downloading to temporary file: ${tempFilePath}`);

    // Sélecteur de format avec fallback automatique
    // Accepte tous les formats (mp4, webm, av1, m3u8) pour avoir accès à la 4K
    // YouTube utilise parfois SABR qui ne fournit que des formats m3u8
    const qualityHeight = quality.replace('p', '');
    const formatSelector = `bestvideo*[height<=${qualityHeight}]+bestaudio/best[height<=${qualityHeight}]/best`;

    console.log(`Using format selector: ${formatSelector} for quality ${quality}`);

    // Mettre à jour la progression
    downloadProgress.set(downloadId, {
      status: 'downloading',
      percentage: 0,
      message: 'Téléchargement en cours...'
    });

    // Télécharger la vidéo avec yt-dlp en utilisant spawn pour capturer la progression
    await new Promise((resolve, reject) => {
      const args = [];

      // Ajouter les cookies si disponibles
      if (USE_COOKIES) {
        args.push('--cookies', COOKIES_PATH);
      }

      // Ajouter runtime JS et User-Agent
      args.push('--js-runtimes', JS_RUNTIME);
      args.push('--user-agent', USER_AGENT);
      args.push('--sleep-requests', '1');

      args.push(
        '-f', formatSelector,
        '--merge-output-format', 'mp4',
        '--fixup', 'detect_or_warn',
        '--postprocessor-args', 'ffmpeg:-movflags +faststart -fflags +genpts',
        '--newline',
        '--progress',
        '-o', tempFilePath,
        videoUrl
      );

      const ytdlp = spawn(YTDLP_PATH, args);

      let stderrData = '';

      ytdlp.stderr.on('data', (data) => {
        const output = data.toString();
        stderrData += output;

        // Log toutes les erreurs importantes
        if (output.includes('ERROR')) {
          console.error('yt-dlp ERROR:', output);
        }

        // Parser la progression de yt-dlp
        const downloadMatch = output.match(/\[download\]\s+(\d+\.?\d*)%/);
        if (downloadMatch) {
          const percentage = parseFloat(downloadMatch[1]);
          downloadProgress.set(downloadId, {
            status: 'downloading',
            percentage: percentage,
            message: `Téléchargement: ${percentage.toFixed(1)}%`
          });
        }

        // Détecter le merge
        if (output.includes('Merging formats')) {
          downloadProgress.set(downloadId, {
            status: 'merging',
            percentage: 95,
            message: 'Fusion vidéo + audio...'
          });
        }
      });

      ytdlp.on('close', (code) => {
        if (code === 0) {
          downloadProgress.set(downloadId, {
            status: 'complete',
            percentage: 100,
            message: 'Téléchargement terminé'
          });
          resolve();
        } else {
          console.error(`yt-dlp failed with code ${code}`);
          console.error('Full stderr output:', stderrData);

          // Vérifier si c'est une erreur SABR streaming
          if (stderrData.includes('SABR streaming') || stderrData.includes('forcing SABR')) {
            reject(new Error('YouTube force le SABR streaming pour cette vidéo. Veuillez mettre à jour yt-dlp avec la commande: yt-dlp.exe -U'));
          }
          // Vérifier si c'est une erreur HTTP 403 Forbidden
          else if (stderrData.includes('HTTP Error 403') || stderrData.includes('Forbidden')) {
            reject(new Error('HTTP 403: YouTube bloque le téléchargement. Solution: 1) Mettez à jour yt-dlp avec "yt-dlp.exe -U" 2) Videz le cache avec "yt-dlp.exe --rm-cache-dir" 3) Rafraîchissez vos cookies YouTube si le problème persiste.'));
          }
          // Vérifier si c'est une erreur de détection bot
          else if (stderrData.includes('Sign in to confirm') || stderrData.includes('not a bot')) {
            reject(new Error('Sign in to confirm you\'re not a bot. Toutes les méthodes de contournement ont échoué. Attendez quelques minutes avant de réessayer.'));
          } else {
            reject(new Error(`yt-dlp exited with code ${code}. Check server logs for details.`));
          }
        }
      });

      ytdlp.on('error', (error) => {
        reject(error);
      });
    });

    console.log(`Download complete, streaming file to client...`);

    // Vérifier que le fichier existe
    if (!fs.existsSync(tempFilePath)) {
      throw new Error('Downloaded file not found');
    }

    // Obtenir la taille du fichier
    const stat = fs.statSync(tempFilePath);
    const fileSize = stat.size;

    // Vérifier que le fichier n'est pas vide ou trop petit (probablement corrompu)
    if (fileSize < 1000) {
      console.error(`Downloaded file is too small: ${fileSize} bytes`);
      throw new Error('Downloaded file appears to be corrupted or incomplete');
    }

    console.log(`File size: ${(fileSize / 1024 / 1024).toFixed(2)} MB`);

    // Définir les headers pour le téléchargement
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Length', fileSize);

    // Créer un stream de lecture et l'envoyer au client
    const fileStream = fs.createReadStream(tempFilePath);

    fileStream.pipe(res);

    // Supprimer le fichier temporaire une fois l'envoi terminé
    fileStream.on('end', () => {
      console.log('File sent to client, deleting temporary file...');
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
        console.log('Temporary file deleted');
      }
    });

    // Gérer les erreurs de lecture
    fileStream.on('error', (error) => {
      console.error('File stream error:', error);
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    });

    // Nettoyer si le client ferme la connexion
    res.on('close', () => {
      fileStream.destroy();
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
        console.log('Client disconnected, deleted temporary file');
      }
    });

  } catch (error) {
    console.error('Error downloading video:', error);

    // Nettoyer le fichier temporaire en cas d'erreur
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }

    // Nettoyer la progression
    downloadProgress.delete(downloadId);

    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
});

// Endpoint pour obtenir la progression d'un téléchargement
app.get('/api/progress/:videoId', (req, res) => {
  const { videoId } = req.params;

  // Trouver la progression la plus récente pour ce videoId
  let latestProgress = null;
  for (const [key, value] of downloadProgress.entries()) {
    if (key.startsWith(videoId)) {
      latestProgress = value;
    }
  }

  if (latestProgress) {
    res.json(latestProgress);
  } else {
    res.json({
      status: 'not_found',
      percentage: 0,
      message: 'Aucun téléchargement en cours'
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'YouTube Downloader Backend is running' });
});

// Vider le cache yt-dlp au démarrage pour éviter les problèmes de signatures obsolètes
async function clearYtdlpCache() {
  try {
    console.log('🧹 Clearing yt-dlp cache...');
    await execAsync(`"${YTDLP_PATH}" --rm-cache-dir`);
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
