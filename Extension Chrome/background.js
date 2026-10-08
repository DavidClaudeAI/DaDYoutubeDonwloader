// Background service worker pour gérer les téléchargements
const BACKEND_URL = 'http://localhost:3010';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'downloadVideo') {
    handleVideoDownload(request)
      .then(result => sendResponse(result))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Indique qu'on va répondre de façon asynchrone
  }

  if (request.action === 'openPopup') {
    chrome.action.openPopup();
    return true;
  }
});

async function handleVideoDownload(request) {
  const { videoId, title } = request;

  try {
    console.log(`Requesting download for video ${videoId}`);

    // Vérifier d'abord que le backend est accessible
    try {
      const healthCheck = await fetch(`${BACKEND_URL}/api/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(3000)
      });

      if (!healthCheck.ok) {
        throw new Error('Backend non accessible');
      }
    } catch (healthError) {
      throw new Error('Le serveur backend n\'est pas démarré. Démarrez-le avec "npm start" dans le dossier backend.');
    }

    // Démarrer le téléchargement sur le serveur (non-bloquant)
    const startResponse = await fetch(`${BACKEND_URL}/api/download/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId, title })
    });

    const startData = await startResponse.json();

    if (!startData.success) {
      throw new Error(startData.error || 'Erreur lors du démarrage du téléchargement');
    }

    const serverDownloadId = startData.downloadId;
    console.log('Server download ID:', serverDownloadId);

    // Polling du statut jusqu'à ce que le fichier soit prêt
    let ready = false;
    let lastProgress = 0;

    while (!ready) {
      await new Promise(resolve => setTimeout(resolve, 1000)); // Attendre 1 seconde

      const statusResponse = await fetch(`${BACKEND_URL}/api/download/status/${serverDownloadId}`);
      const statusData = await statusResponse.json();

      if (!statusData.success) {
        throw new Error(statusData.error || 'Erreur lors de la vérification du statut');
      }

      console.log(`Download status: ${statusData.status} - ${statusData.progress}%`);

      if (statusData.status === 'error') {
        throw new Error(statusData.error || 'Erreur lors du téléchargement sur le serveur');
      }

      if (statusData.status === 'ready') {
        ready = true;
      }

      lastProgress = statusData.progress;
    }

    // Le fichier est prêt, télécharger depuis le serveur
    const fileUrl = `${BACKEND_URL}/api/download/file/${serverDownloadId}`;
    const sanitizedTitle = sanitizeFilename(title);
    const filename = `${sanitizedTitle}.mp4`;

    const chromeDownloadId = await chrome.downloads.download({
      url: fileUrl,
      filename: filename,
      saveAs: true
    });

    console.log('Chrome download started with ID:', chromeDownloadId);

    // Télécharger automatiquement le fichier .url raccourci
    try {
      const urlFileUrl = `${BACKEND_URL}/api/download/url/${serverDownloadId}`;
      const urlFilename = `${sanitizedTitle}.url`;

      const urlDownloadId = await chrome.downloads.download({
        url: urlFileUrl,
        filename: urlFilename,
        saveAs: true // Permettre de choisir le même dossier que la vidéo
      });

      console.log('URL shortcut download started with ID:', urlDownloadId);
    } catch (urlError) {
      console.error('Error downloading URL shortcut:', urlError);
      // Ne pas bloquer si le téléchargement du .url échoue
    }

    return { success: true, downloadId: chromeDownloadId, message: 'Téléchargement terminé' };

  } catch (error) {
    console.error('Download error:', error);
    throw error;
  }
}

function sanitizeFilename(filename) {
  // Remplacer les caractères invalides pour les noms de fichiers
  return filename
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, '_')
    .substring(0, 100); // Limiter la longueur
}

// Écouter les événements de téléchargement
chrome.downloads.onChanged.addListener((delta) => {
  if (delta.state && delta.state.current === 'complete') {
    console.log('Download completed:', delta.id);
  }

  if (delta.error) {
    console.error('Download error:', delta.error);
  }
});
