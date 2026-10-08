# YouTube Video Downloader - Extension Chrome Autonome

Extension Chrome avec serveur backend local pour télécharger des vidéos YouTube de manière autonome.

## 🎯 Fonctionnalités

- ✅ Téléchargement autonome sans services tiers
- 🎬 Interface popup élégante avec aperçu de la vidéo
- 🎚️ Meilleure qualité disponible, automatiquement, jusqu'en 4K (2160p)
- 🎬 Fichiers prêts pour DaVinci Resolve (voir « Formats et DaVinci Resolve »)
- 📥 Téléchargement direct via le backend local
- 🔘 Bouton intégré sur la page YouTube

## 📁 Structure du projet

```
Youtube vidéo downloader/
├── Extension Chrome/        # Extension Chrome
│   ├── manifest.json
│   ├── popup.html
│   ├── popup.css
│   ├── popup.js
│   ├── content.js
│   ├── background.js
│   ├── config.js
│   └── icons/
└── backend/                 # Serveur Node.js
    ├── server.js
    ├── package.json
    └── downloads/          # Dossier des vidéos téléchargées
```

## 🚀 Installation

### Étape 1 : Préparer les icônes

Créez 3 fichiers PNG dans `Extension Chrome/icons/` :
- `icon16.png` (16x16 pixels)
- `icon48.png` (48x48 pixels)
- `icon128.png` (128x128 pixels)

**Astuce** : Utilisez [favicon-generator.org](https://www.favicon-generator.org/) pour les créer rapidement.

### Étape 2 : Démarrer le serveur backend

```bash
cd backend
npm install
npm start
```

Le serveur devrait démarrer sur `http://localhost:3010`

### Étape 3 : Charger l'extension dans Chrome

1. Ouvrez Chrome et allez à `chrome://extensions/`
2. Activez le **Mode développeur** (en haut à droite)
3. Cliquez sur **Charger l'extension non empaquetée**
4. Sélectionnez le dossier `Extension Chrome`
5. L'extension apparaît dans votre barre d'outils

## 📖 Utilisation

### Méthode 1 : Via le popup

1. Ouvrez une vidéo YouTube
2. Cliquez sur l'icône de l'extension
3. Cliquez sur **Télécharger la vidéo**
4. Le fichier sera téléchargé dans votre dossier de téléchargements

### Méthode 2 : Bouton sur la page

1. Ouvrez une vidéo YouTube
2. Cliquez sur le bouton **📥 Télécharger** sous la vidéo
3. Le popup s'ouvre : cliquez sur **Télécharger la vidéo**

## 🔧 Configuration

Modifiez `Extension Chrome/config.js` pour changer :
- L'URL du backend (par défaut : `http://localhost:3010`)

Le plafond de résolution (`MAX_HEIGHT`, 2160) et le choix du format sont dans `backend/server.js`.

## ⚙️ Comment ça fonctionne ?

```
┌─────────────────┐
│  Extension      │
│  Chrome         │
└────────┬────────┘
         │ 1. Demande l'URL de téléchargement
         ↓
┌─────────────────┐
│  Serveur        │
│  Backend        │
│  (Node.js)      │
└────────┬────────┘
         │ 2. Utilise yt-dlp pour extraire l'URL
         ↓
┌─────────────────┐
│  YouTube        │
└────────┬────────┘
         │ 3. Retourne l'URL de streaming
         ↓
┌─────────────────┐
│  Chrome         │
│  télécharge     │
│  directement    │
└─────────────────┘
```

## 🛠️ Dépendances

### Backend
- **Node.js** (v14+)
- **express** - Serveur web
- **cors** - Gestion CORS
- **youtube-dl-exec** - Interface pour yt-dlp

Le package `youtube-dl-exec` télécharge automatiquement `yt-dlp` lors de l'installation.

## 🐛 Dépannage

### Le téléchargement ne démarre pas

1. **Vérifiez que le serveur backend est démarré** :
   ```bash
   cd backend
   npm start
   ```

2. **Vérifiez dans la console Chrome** (F12) :
   - S'il y a une erreur de connexion au backend
   - Si le backend retourne une erreur

3. **Rechargez l'extension** dans `chrome://extensions/`

### Erreur "Failed to fetch"

Le serveur backend n'est pas accessible. Assurez-vous qu'il tourne sur le port 3010.

### Vidéo de mauvaise qualité

Le serveur prend toujours la meilleure résolution proposée par YouTube, jusqu'en 4K. Si le fichier est en dessous, c'est que YouTube ne propose pas mieux pour cette vidéo — ou que le repli « qualité adaptée » s'est déclenché (blocage nsig/SABR/403 de YouTube, visible dans les logs du serveur).

## 🎬 Formats et DaVinci Resolve

Le serveur livre toujours un `.mp4` que DaVinci Resolve lit sans « média manquant » :

| Ce que YouTube propose | Ce que le serveur livre |
|---|---|
| AV1 8 bits (le cas le plus fréquent en 4K) | gardé tel quel |
| H.264 ou HEVC | gardé tel quel |
| VP9 seulement | converti en HEVC par la carte graphique (NVENC) |
| AV1 10 bits (versions HDR) | converti en HEVC 10 bits |
| Son Opus | converti en AAC 320 kb/s |

Pourquoi : sur Resolve 21.1 (RTX 3080 Ti), le VP9 échoue au décodage sur l'image qui précède chaque image clé (« Failed to decode the video frame » dans `davinci_resolve.log`), ce qui produit des flashs de média manquant. L'AV1 8 bits, le H.264 et le HEVC se lisent sans erreur. Les versions SDR sont préférées aux HDR.

La conversion n'a lieu que si nécessaire ; elle va environ trois fois plus vite que la durée de la vidéo. Elle nécessite `ffmpeg` et `ffprobe` dans le PATH, avec l'encodeur `hevc_nvenc` (carte NVIDIA).

## ⚠️ Avertissement légal

Le téléchargement de vidéos YouTube peut violer les conditions d'utilisation de YouTube.

**Cette extension est fournie à des fins éducatives uniquement.**

Utilisez-la de manière responsable et respectez :
- Les droits d'auteur
- Les conditions d'utilisation de YouTube
- Les lois locales sur le droit d'auteur

## 📝 Notes techniques

- L'extension utilise Manifest V3
- Le backend appelle `backend/yt-dlp.exe` directement, puis `ffmpeg` pour préparer le fichier
- La vidéo est téléchargée dans `backend/downloads/`, envoyée à Chrome, puis supprimée
- Chaque téléchargement livre aussi un raccourci `.url` vers la vidéo YouTube, proposé juste après la vidéo
- `backend/downloads/` est un dossier temporaire : il est vidé à chaque démarrage du serveur

## 🔄 Développement

### Mode développement du backend

```bash
cd backend
npm run dev
```

Ceci utilise `nodemon` pour redémarrer automatiquement le serveur lors des modifications.

### Logs

- **Backend** : Les logs s'affichent dans le terminal où vous avez lancé `npm start`
- **Extension** : Ouvrez la console (F12) sur la page YouTube ou inspectez le service worker dans `chrome://extensions/`

## 📦 Production

Pour une utilisation en production, vous devriez :

1. Empaqueter l'extension pour le Chrome Web Store
2. Déployer le backend sur un serveur (Heroku, DigitalOcean, etc.)
3. Mettre à jour `config.js` avec l'URL du serveur de production
4. Ajouter une authentification au backend
5. Implémenter des limites de taux (rate limiting)

## 🎨 Personnalisation

### Changer les couleurs du popup

Modifiez `Extension Chrome/popup.css` :
```css
background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
```

### Changer le port du backend

Modifiez `backend/server.js` :
```javascript
const PORT = 3010; // Changez cette valeur
```

Et mettez à jour `Extension Chrome/config.js` en conséquence.

## 🤝 Contribution

Les contributions sont les bienvenues ! N'hésitez pas à ouvrir une issue ou une pull request.

## 📄 Licence

Ce projet est fourni à des fins éducatives. Utilisez-le de manière responsable.
