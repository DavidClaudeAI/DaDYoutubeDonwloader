# YouTube Video Downloader - Installation

## 📋 Prérequis

1. Google Chrome ou un navigateur basé sur Chromium (Edge, Brave, etc.)
2. Node.js installé sur votre machine
3. Les icônes PNG sont déjà incluses

## 🚀 Installation

### 1. Démarrer le serveur backend

```bash
cd "F:\Dev diverses\Youtube vidéo downloader\backend"
npm install
npm start
```

Le serveur backend doit être démarré sur `http://localhost:3010` avant d'utiliser l'extension.

### 2. Installer l'extension Chrome

1. Ouvrez Chrome et allez à `chrome://extensions/`
2. Activez le **mode développeur** (interrupteur en haut à droite)
3. Cliquez sur **"Charger l'extension non empaquetée"**
4. Sélectionnez le dossier : `F:\Dev diverses\Youtube vidéo downloader\Extension Chrome`
5. L'extension apparaîtra dans votre barre d'outils Chrome

## 📖 Utilisation

### Méthode 1 : Via le popup de l'extension
1. Ouvrez une vidéo YouTube
2. Cliquez sur l'icône de l'extension dans la barre d'outils
3. Les informations de la vidéo s'afficheront automatiquement
4. Cliquez sur "Télécharger la vidéo" (meilleure qualité disponible, jusqu'en 4K)
5. Suivez la progression en temps réel dans le popup

### Méthode 2 : Bouton sur la page YouTube
1. Ouvrez une vidéo YouTube
2. Un bouton bleu "📥 Télécharger" apparaîtra sous la vidéo
3. Cliquez dessus : le popup s'ouvre, cliquez sur "Télécharger la vidéo"

## 🔧 Dépannage

**Le serveur backend ne démarre pas** :
- Vérifiez que Node.js est installé : `node --version`
- Assurez-vous que le port 3010 n'est pas déjà utilisé

**L'extension ne s'affiche pas** :
- Rechargez l'extension dans `chrome://extensions/`
- Vérifiez que toutes les icônes sont présentes dans le dossier `icons/`

**Le bouton ne s'affiche pas sur YouTube** :
- Actualisez la page YouTube
- Vérifiez que l'extension est bien activée

**Le téléchargement échoue** :
- Assurez-vous que le serveur backend est démarré
- Vérifiez les logs du serveur backend pour les erreurs
- Certaines vidéos peuvent ne pas être disponibles au téléchargement

## 📁 Structure du projet

```
backend/
├── server.js             # Serveur Express avec yt-dlp
├── package.json          # Dépendances Node.js
├── yt-dlp.exe           # Outil de téléchargement YouTube
└── downloads/            # Dossier temporaire pour les téléchargements

Extension Chrome/
├── manifest.json         # Configuration de l'extension
├── popup.html           # Interface utilisateur du popup
├── popup.css            # Styles du popup
├── popup.js             # Logique du popup avec progression
├── content.js           # Script injecté sur YouTube
├── background.js        # Service worker d'arrière-plan
└── icons/               # Icônes de l'extension
    ├── icon16.png
    ├── icon48.png
    └── icon128.png
```

## 🛡️ Avertissement légal

Télécharger des vidéos YouTube peut violer les conditions d'utilisation de YouTube.
Cette extension est fournie à des fins éducatives uniquement.
Utilisez-la de manière responsable et respectez les droits d'auteur.
