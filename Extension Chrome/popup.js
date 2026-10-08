document.addEventListener('DOMContentLoaded', async () => {
  const videoInfo = document.getElementById('videoInfo');
  const thumbnail = document.getElementById('thumbnail');
  const videoTitle = document.getElementById('videoTitle');
  const videoChannel = document.getElementById('videoChannel');
  const status = document.getElementById('status');
  const downloadBtn = document.getElementById('downloadBtn');
  const progressContainer = document.getElementById('progressContainer');
  const progressMessage = document.getElementById('progressMessage');
  const progressPercent = document.getElementById('progressPercent');
  const progressFill = document.getElementById('progressFill');

  let currentVideoData = null;

  // Vérifier s'il y a un téléchargement en cours
  const { activeDownload } = await chrome.storage.local.get('activeDownload');
  if (activeDownload) {
    // Restaurer l'état du téléchargement en cours
    currentVideoData = activeDownload.videoData;

    displayVideoInfo(currentVideoData);

    // Réactiver la surveillance du téléchargement
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Téléchargement en cours...';
    downloadBtn.classList.remove('hidden');
    progressContainer.classList.remove('hidden');

    monitorDownload(activeDownload.downloadId);
    return;
  }

  // Vérifier si on est sur une page YouTube (vidéo normale ou Short)
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab.url || !(tab.url.includes('youtube.com/watch') || tab.url.includes('youtube.com/shorts'))) {
    status.textContent = 'Veuillez ouvrir une vidéo YouTube ou un Short.';
    status.className = 'status-message error';
    return;
  }

  status.textContent = 'Chargement des informations de la vidéo...';
  status.className = 'status-message';

  // Récupérer les informations de la vidéo depuis le content script
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'getVideoInfo' });

    if (response && response.success) {
      currentVideoData = response.data;
      displayVideoInfo(response.data);
      status.textContent = '';
    } else {
      status.textContent = response?.error || 'Impossible de récupérer les informations de la vidéo.';
      status.className = 'status-message error';
    }
  } catch (error) {
    console.error('Error:', error);
    status.textContent = 'Erreur lors de la communication avec la page.';
    status.className = 'status-message error';
  }

  function displayVideoInfo(data) {
    videoInfo.classList.remove('hidden');
    thumbnail.src = data.thumbnail;
    videoTitle.textContent = data.title;
    videoChannel.textContent = data.channel;

    downloadBtn.classList.remove('hidden');
  }

  // Fonction pour réinitialiser l'UI après une erreur
  async function resetDownloadState(errorMessage) {
    await chrome.storage.local.remove('activeDownload');
    progressContainer.classList.add('hidden');
    status.textContent = errorMessage;
    status.className = 'status-message error';
    downloadBtn.textContent = 'Télécharger la vidéo';
    downloadBtn.disabled = false;
  }

  // Fonction pour surveiller un téléchargement
  function monitorDownload(serverDownloadId) {
    let networkErrorCount = 0;
    const MAX_NETWORK_ERRORS = 5;

    const progressInterval = setInterval(async () => {
        try {
          const statusResponse = await fetch(`http://localhost:3010/api/download/status/${serverDownloadId}`);

          if (!statusResponse.ok) {
            clearInterval(progressInterval);
            await resetDownloadState(`Erreur serveur (${statusResponse.status}). Veuillez réessayer.`);
            return;
          }

          // Réinitialiser le compteur en cas de succès
          networkErrorCount = 0;

          const statusData = await statusResponse.json();

          if (statusData.success) {
            const progress = statusData.progress || 0;
            const message = statusData.message || 'En cours...';

            // Mettre à jour la barre de progression
            progressMessage.textContent = message;
            progressPercent.textContent = `${progress.toFixed(1)}%`;
            progressFill.style.width = `${progress}%`;

            if (statusData.status === 'error') {
              clearInterval(progressInterval);
              await resetDownloadState(statusData.error || 'Erreur lors du téléchargement');
              return;
            }

            if (statusData.status === 'ready') {
              clearInterval(progressInterval);
              progressMessage.textContent = 'Récupération du fichier...';
              progressPercent.textContent = '100%';
              progressFill.style.width = '100%';

              // Télécharger le fichier directement via Chrome
              const fileUrl = `http://localhost:3010/api/download/file/${serverDownloadId}`;
              const sanitizedTitle = currentVideoData.title.replace(/[<>:"/\\|?*]/g, '').replace(/\s+/g, '_').substring(0, 100);
              const filename = `${sanitizedTitle}.mp4`;

              const chromeDownloadId = await chrome.downloads.download({
                url: fileUrl,
                filename: filename,
                saveAs: true
              });

              console.log('Chrome download started:', chromeDownloadId);

              // Télécharger automatiquement le fichier .url raccourci
              try {
                const urlFileUrl = `http://localhost:3010/api/download/url/${serverDownloadId}`;
                const urlFilename = `${sanitizedTitle}.url`;

                const urlDownloadId = await chrome.downloads.download({
                  url: urlFileUrl,
                  filename: urlFilename,
                  saveAs: true // Permettre de choisir le même dossier que la vidéo
                });

                console.log('URL shortcut download started:', urlDownloadId);
              } catch (urlError) {
                console.error('Error downloading URL shortcut:', urlError);
                // Ne pas bloquer si le téléchargement du .url échoue
              }

              // Supprimer l'état sauvegardé
              await chrome.storage.local.remove('activeDownload');

              progressContainer.classList.add('hidden');
              status.textContent = '✓ Téléchargement terminé !';
              status.className = 'status-message success';
              downloadBtn.textContent = 'Télécharger la vidéo';
              downloadBtn.disabled = false;
            }
          }
        } catch (error) {
          console.error('Progress check error:', error);
          networkErrorCount++;
          if (networkErrorCount >= MAX_NETWORK_ERRORS) {
            clearInterval(progressInterval);
            await resetDownloadState('Connexion au serveur perdue. Vérifiez que le serveur est démarré puis réessayez.');
          }
        }
      }, 500);
  }

  downloadBtn.addEventListener('click', async () => {
    if (!currentVideoData) {
      return;
    }

    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Téléchargement en cours...';
    status.textContent = '';
    status.className = 'status-message hidden';

    // Afficher la barre de progression
    progressContainer.classList.remove('hidden');
    progressMessage.textContent = 'Démarrage du téléchargement...';
    progressPercent.textContent = '0%';
    progressFill.style.width = '0%';

    try {
      // Démarrer le téléchargement sur le serveur
      const startResponse = await fetch('http://localhost:3010/api/download/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          videoId: currentVideoData.videoId,
          title: currentVideoData.title
        })
      });

      if (!startResponse.ok) {
        const errorData = await startResponse.json();
        throw new Error(errorData.error || 'Erreur lors du démarrage');
      }

      const startData = await startResponse.json();
      if (!startData.success) {
        throw new Error(startData.error || 'Erreur lors du démarrage');
      }

      const serverDownloadId = startData.downloadId;
      console.log('Server download ID:', serverDownloadId);

      // Sauvegarder l'état du téléchargement
      await chrome.storage.local.set({
        activeDownload: {
          downloadId: serverDownloadId,
          videoData: currentVideoData
        }
      });

      // Surveiller la progression
      monitorDownload(serverDownloadId);

    } catch (error) {
      console.error('Download error:', error);

      let errorMessage = error.message;

      // Gérer les différents types d'erreurs
      if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
        errorMessage = '⚠️ Serveur backend non accessible. Assurez-vous qu\'il est démarré (npm start dans le dossier backend).';
      } else if (error.message.includes('Trop de téléchargements')) {
        errorMessage = '⏳ ' + error.message;
      } else if (error.message.includes('Sign in to confirm') || error.message.includes('not a bot')) {
        errorMessage = '🤖 YouTube a détecté l\'activité comme un bot.\n\n' +
          '📝 Solution:\n' +
          '1. Installez l\'extension Chrome "Get cookies.txt LOCALLY"\n' +
          '2. Connectez-vous à YouTube dans votre navigateur\n' +
          '3. Exportez vos cookies YouTube avec l\'extension\n' +
          '4. Renommez le fichier en "cookies.txt"\n' +
          '5. Placez-le dans le dossier "backend"\n' +
          '6. Redémarrez le serveur backend';
      }

      progressContainer.classList.add('hidden');
      status.textContent = errorMessage;
      status.className = 'status-message error';
      downloadBtn.textContent = 'Télécharger la vidéo';
      downloadBtn.disabled = false;
    }
  });
});
