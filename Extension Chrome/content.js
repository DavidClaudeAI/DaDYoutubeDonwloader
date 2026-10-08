// Content script pour extraire les informations de la vidéo YouTube

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'getVideoInfo') {
    try {
      const videoInfo = extractVideoInfo();
      sendResponse({ success: true, data: videoInfo });
    } catch (error) {
      console.error('Error extracting video info:', error);
      sendResponse({ success: false, error: error.message });
    }
    return true; // Indique qu'on va répondre de façon asynchrone
  }
});

function extractVideoInfo() {
  let videoId = null;
  const currentUrl = window.location.href;

  // Détecter si c'est un Short ou une vidéo normale
  const isShort = currentUrl.includes('/shorts/');

  if (isShort) {
    // Extraire l'ID depuis /shorts/VIDEO_ID
    const shortMatch = currentUrl.match(/\/shorts\/([a-zA-Z0-9_-]+)/);
    if (shortMatch) {
      videoId = shortMatch[1];
    }
  } else {
    // Méthode classique pour /watch?v=
    const urlParams = new URLSearchParams(window.location.search);
    videoId = urlParams.get('v');
  }

  if (!videoId) {
    throw new Error('ID de vidéo introuvable');
  }

  // Récupérer le titre de la vidéo
  let titleElement = null;
  let title = 'Titre indisponible';

  if (isShort) {
    // Sélecteurs spécifiques pour les Shorts
    titleElement = document.querySelector('ytd-reel-video-renderer[is-active] h2.ytd-reel-player-header-renderer yt-formatted-string') ||
                   document.querySelector('#shorts-player h2 yt-formatted-string') ||
                   document.querySelector('ytd-reel-video-renderer h2 yt-formatted-string');
  } else {
    // Sélecteurs classiques pour les vidéos normales
    titleElement = document.querySelector('h1.ytd-watch-metadata yt-formatted-string');
  }

  if (titleElement) {
    title = titleElement.textContent.trim();
  }

  // Récupérer le nom de la chaîne
  let channelElement = null;
  let channel = 'Chaîne inconnue';

  if (isShort) {
    // Sélecteurs pour les Shorts
    channelElement = document.querySelector('ytd-reel-video-renderer[is-active] ytd-channel-name a') ||
                     document.querySelector('#shorts-player ytd-channel-name a') ||
                     document.querySelector('ytd-reel-video-renderer ytd-channel-name a');
  } else {
    // Sélecteur classique
    channelElement = document.querySelector('ytd-channel-name#channel-name a');
  }

  if (channelElement) {
    channel = channelElement.textContent.trim();
  }

  // Récupérer la miniature
  const thumbnail = `https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg`;

  // Récupérer la durée
  let duration = 'Inconnue';
  const timeElement = document.querySelector('.ytp-time-duration');
  if (timeElement) {
    duration = timeElement.textContent;
  }

  return {
    videoId,
    title,
    channel,
    thumbnail,
    duration,
    url: currentUrl,
    isShort
  };
}

// Injecter un bouton de téléchargement sur la page YouTube
function injectDownloadButton() {
  // Vérifier si le bouton existe déjà
  if (document.getElementById('custom-youtube-download-btn')) {
    return;
  }

  const currentUrl = window.location.href;
  const isShort = currentUrl.includes('/shorts/');

  let targetNode = null;

  if (isShort) {
    // Pour les Shorts, chercher le conteneur d'actions
    targetNode = document.querySelector('ytd-reel-video-renderer[is-active] #actions') ||
                 document.querySelector('#shorts-player #actions') ||
                 document.querySelector('ytd-reel-video-renderer #actions');
  } else {
    // Pour les vidéos normales
    targetNode = document.querySelector('#top-level-buttons-computed');
  }

  if (!targetNode) {
    setTimeout(injectDownloadButton, 1000);
    return;
  }

  // Créer le bouton de téléchargement
  const downloadBtn = document.createElement('button');
  downloadBtn.id = 'custom-youtube-download-btn';

  if (isShort) {
    // Style adapté pour les Shorts (bouton vertical)
    downloadBtn.className = 'yt-spec-button-shape-next';
    downloadBtn.innerHTML = `
      <div style="display: flex; flex-direction: column; align-items: center; padding: 8px;">
        <span style="font-size: 24px;">📥</span>
        <span style="font-size: 12px; margin-top: 4px;">Télécharger</span>
      </div>
    `;
    downloadBtn.style.cssText = `
      cursor: pointer;
      background-color: rgba(255, 255, 255, 0.1);
      color: white;
      border: none;
      border-radius: 50%;
      width: 48px;
      height: 48px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 8px;
      transition: background-color 0.2s;
    `;
  } else {
    // Style classique pour les vidéos normales
    downloadBtn.className = 'yt-spec-button-shape-next yt-spec-button-shape-next--tonal yt-spec-button-shape-next--mono yt-spec-button-shape-next--size-m';
    downloadBtn.innerHTML = `
      <div class="yt-spec-button-shape-next__button-text-content">
        <span class="yt-spec-button-shape-next__button-text">📥 Télécharger</span>
      </div>
    `;
    downloadBtn.style.cssText = `
      margin-left: 8px;
      cursor: pointer;
      padding: 0 16px;
      height: 36px;
      border-radius: 18px;
      background-color: #065fd4;
      color: white;
      border: none;
      font-weight: 500;
      font-size: 14px;
      transition: background-color 0.2s;
    `;
  }

  downloadBtn.addEventListener('mouseenter', () => {
    if (isShort) {
      downloadBtn.style.backgroundColor = 'rgba(255, 255, 255, 0.2)';
    } else {
      downloadBtn.style.backgroundColor = '#0448a0';
    }
  });

  downloadBtn.addEventListener('mouseleave', () => {
    if (isShort) {
      downloadBtn.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
    } else {
      downloadBtn.style.backgroundColor = '#065fd4';
    }
  });

  downloadBtn.addEventListener('click', () => {
    // Ouvrir le popup de l'extension pour choisir la qualité
    chrome.runtime.sendMessage({ action: 'openPopup' });
  });

  // Insérer le bouton
  if (isShort) {
    // Pour les Shorts, ajouter au début de la colonne d'actions
    targetNode.insertBefore(downloadBtn, targetNode.firstChild);
  } else {
    // Pour les vidéos normales, ajouter au début des boutons
    targetNode.insertBefore(downloadBtn, targetNode.firstChild);
  }
}

// Observer les changements de page (YouTube est une SPA)
let lastUrl = location.href;
new MutationObserver(() => {
  const url = location.href;
  if (url !== lastUrl) {
    lastUrl = url;
    // Détecter les vidéos normales ET les Shorts
    if (url.includes('/watch?v=') || url.includes('/shorts/')) {
      setTimeout(injectDownloadButton, 2000);
    }
  }
}).observe(document.body, { subtree: true, childList: true });

// Injecter le bouton au chargement initial
if (window.location.href.includes('/watch?v=') || window.location.href.includes('/shorts/')) {
  setTimeout(injectDownloadButton, 2000);
}
