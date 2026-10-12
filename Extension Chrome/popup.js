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
  const cancelBtn = document.getElementById('cancelBtn');

  let currentVideoData = null;

  // Le téléchargement suivi par ce popup : son identifiant côté serveur (connu
  // une fois le démarrage accepté), sa surveillance, et s'il a été annulé.
  // Chaque lancement a le sien : une réponse du serveur qui arrive après une
  // annulation concerne un téléchargement révolu et ne touche plus à l'écran.
  let currentJob = null;

  function newJob() {
    currentJob = { serverId: null, interval: null, cancelled: false };
    return currentJob;
  }

  // Affiche l'état « en cours » : bouton grisé, progression et bouton Annuler.
  function showDownloading() {
    downloadBtn.disabled = true;
    downloadBtn.textContent = 'Téléchargement en cours...';
    downloadBtn.classList.remove('hidden');
    progressContainer.classList.remove('hidden');
    cancelBtn.classList.remove('hidden');
  }

  // Remet le popup dans l'état d'une ouverture : vidéo affichée, bouton
  // Télécharger actif, ni progression ni message.
  async function resetToIdle() {
    if (currentJob) {
      clearInterval(currentJob.interval);
    }
    currentJob = null;
    await chrome.storage.local.remove('activeDownload');
    progressContainer.classList.add('hidden');
    progressMessage.textContent = 'Téléchargement en cours...';
    progressPercent.textContent = '0%';
    progressFill.style.width = '0%';
    cancelBtn.classList.add('hidden');
    cancelBtn.disabled = false;
    status.textContent = '';
    status.className = 'status-message';
    downloadBtn.textContent = 'Télécharger la vidéo';
    downloadBtn.disabled = false;
  }

  // Demande au serveur d'arrêter et d'effacer ce téléchargement. Si le
  // serveur ne répond pas, il n'y a rien à arrêter de ce côté-ci.
  async function cancelOnServer(serverId) {
    try {
      await fetch(`http://localhost:3010/api/download/cancel/${serverId}`, { method: 'POST' });
    } catch (error) {
      console.error('Cancel request error:', error);
    }
  }

  cancelBtn.addEventListener('click', async () => {
    const job = currentJob;
    if (!job) {
      return;
    }
    job.cancelled = true;
    cancelBtn.disabled = true;
    await resetToIdle();
    // Sans identifiant, le démarrage est encore en route : le bouton
    // Télécharger annulera le téléchargement dès que le serveur l'aura créé.
    if (job.serverId) {
      await cancelOnServer(job.serverId);
    }
  });

  // Vérifier s'il y a un téléchargement en cours
  const { activeDownload } = await chrome.storage.local.get('activeDownload');
  if (activeDownload) {
    // Restaurer l'état du téléchargement en cours
    currentVideoData = activeDownload.videoData;

    displayVideoInfo(currentVideoData);

    // Réactiver la surveillance du téléchargement
    showDownloading();
    const job = newJob();
    job.serverId = activeDownload.downloadId;
    monitorDownload(job);
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
    await resetToIdle();
    status.textContent = errorMessage;
    status.className = 'status-message error';
  }

  // Fonction pour surveiller un téléchargement
  function monitorDownload(job) {
    const serverDownloadId = job.serverId;
    let networkErrorCount = 0;
    const MAX_NETWORK_ERRORS = 5;

    const progressInterval = setInterval(async () => {
        try {
          const statusResponse = await fetch(`http://localhost:3010/api/download/status/${serverDownloadId}`);
          if (job.cancelled) {
            return;
          }

          if (!statusResponse.ok) {
            clearInterval(progressInterval);
            await resetDownloadState(`Erreur serveur (${statusResponse.status}). Veuillez réessayer.`);
            return;
          }

          // Réinitialiser le compteur en cas de succès
          networkErrorCount = 0;

          const statusData = await statusResponse.json();
          if (job.cancelled) {
            return;
          }

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
              // Le fichier passe à Chrome, dont la fenêtre d'enregistrement
              // a son propre bouton Annuler.
              cancelBtn.classList.add('hidden');
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

              await resetToIdle();
              status.textContent = '✓ Téléchargement terminé !';
              status.className = 'status-message success';
            }
          }
        } catch (error) {
          if (job.cancelled) {
            return;
          }
          console.error('Progress check error:', error);
          networkErrorCount++;
          if (networkErrorCount >= MAX_NETWORK_ERRORS) {
            clearInterval(progressInterval);
            await resetDownloadState('Connexion au serveur perdue. Vérifiez que le serveur est démarré puis réessayez.');
          }
        }
      }, 500);
    job.interval = progressInterval;
  }

  downloadBtn.addEventListener('click', async () => {
    if (!currentVideoData) {
      return;
    }

    const job = newJob();
    showDownloading();
    status.textContent = '';
    status.className = 'status-message hidden';

    // Afficher la barre de progression
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
      job.serverId = serverDownloadId;

      // Annulé pendant que le serveur démarrait : le popup est déjà revenu
      // à l'état initial, il reste à arrêter ce que le serveur a lancé.
      if (job.cancelled) {
        await cancelOnServer(serverDownloadId);
        return;
      }

      // Sauvegarder l'état du téléchargement
      await chrome.storage.local.set({
        activeDownload: {
          downloadId: serverDownloadId,
          videoData: currentVideoData
        }
      });

      // Surveiller la progression
      monitorDownload(job);

    } catch (error) {
      if (job.cancelled) {
        return;
      }
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

      await resetToIdle();
      status.textContent = errorMessage;
      status.className = 'status-message error';
    }
  });
});
