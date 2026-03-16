import express from 'express';
import { createServer as createViteServer } from 'vite';
import { createRequire } from 'module';
import * as qrcode from 'qrcode';
import * as fs from 'fs';
import * as path from 'path';

// Use createRequire to load whatsapp-web.js (CommonJS module) from ESM context
const require = createRequire(import.meta.url);
const { Client, LocalAuth } = require('whatsapp-web.js');
const puppeteer = require('puppeteer');

const AUTH_PATH = '.wwebjs_auth';

// ---- WhatsApp Client Setup ----
let qrCodeData: string | null = null;
let clientStatus: 'initializing' | 'qr' | 'authenticated' | 'connected' | 'disconnected' = 'initializing';
let lastError: string | null = null;
let detectedPath: string | null = null;

const createClient = () => {
  // Recherche du binaire Chrome dans le cache Puppeteer
  const findChrome = (dir: string): string | null => {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isDirectory()) {
        const found = findChrome(fullPath);
        if (found) return found;
      } else if (file === 'chrome' || file === 'google-chrome') {
        // Vérifier si c'est un exécutable (simplifié pour Render/Linux)
        return fullPath;
      }
    }
    return null;
  };

  try {
    // 1. Essayer de trouver dans le cache configuré dans .puppeteerrc.cjs
    const localCache = path.join(process.cwd(), '.cache', 'puppeteer');
    detectedPath = findChrome(localCache);

    // 2. Si non trouvé, essayer le chemin environnement Render
    if (!detectedPath && process.env.PUPPETEER_CACHE_DIR) {
      detectedPath = findChrome(process.env.PUPPETEER_CACHE_DIR);
    }

    // 3. Dernier recours : chemin par défaut de puppeteer
    if (!detectedPath) {
      detectedPath = puppeteer.executablePath();
    }
    
    console.log(`[Puppeteer] Binaire Chrome localisé : ${detectedPath}`);
  } catch (e) {
    console.warn('[Puppeteer] Erreur lors de la détection du binaire:', e);
  }

  const newClient = new Client({
    authStrategy: new LocalAuth({
      dataPath: AUTH_PATH,
    }),
    webVersionCache: {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1035216863.html',
    },
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
      ],
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || detectedPath || undefined,
    },
  });

  console.log('[WhatsApp] Instance du client créée.');

  newClient.on('qr', async (qr: string) => {
    console.log('[WhatsApp] QR Code reçu.');
    clientStatus = 'qr';
    qrCodeData = await qrcode.toDataURL(qr);
  });

  newClient.on('ready', () => {
    console.log('[WhatsApp] Client connecté et prêt !');
    clientStatus = 'connected';
    qrCodeData = null;
    lastError = null;
  });

  newClient.on('authenticated', () => {
    console.log('[WhatsApp] Authentification réussie.');
    clientStatus = 'authenticated';
    qrCodeData = null;
  });

  newClient.on('auth_failure', (msg: string) => {
    console.error('[WhatsApp] Échec d\'authentification:', msg);
    clientStatus = 'disconnected';
    lastError = `Auth Failure: ${msg}`;
    qrCodeData = null;
  });

  newClient.on('disconnected', (reason: string) => {
    console.log('[WhatsApp] Client déconnecté:', reason);
    clientStatus = 'disconnected';
    lastError = `Disconnected: ${reason}`;
    qrCodeData = null;
  });

  return newClient;
};

let client = createClient();

// Start the WhatsApp client
const initializeClient = () => {
  console.log('[WhatsApp] Initialisation du client...');
  clientStatus = 'initializing';
  lastError = null;
  client.initialize()
    .then(() => console.log('[WhatsApp] client.initialize() a terminé (promesse résolue).'))
    .catch((err: Error) => {
      console.error('[WhatsApp] Erreur fatale d\'initialisation:', err);
      clientStatus = 'disconnected';
      lastError = `Init Error: ${err.message}`;
    });
};

// initializeClient();

// ---- Express Server ----
async function startServer() {
  const app = express();
  const PORT = process.env.PORT || 3000;

  app.use(express.json({ limit: '50mb' }));

  /**
   * GET /api/whatsapp/status
   */
  app.get('/api/whatsapp/status', (_req: any, res: any) => {
    console.log(`[API] Status check - Status: ${clientStatus}`);
    res.json({
      status: clientStatus,
      qr: clientStatus === 'qr' ? qrCodeData : null,
    });
  });

  /**
   * GET /api/health
   */
  app.get('/api/health', (_req, res) => {
    res.json({ 
      status: 'ok', 
      whatsappStatus: clientStatus,
      hasQR: !!qrCodeData,
      lastError: lastError,
      detectedPath: detectedPath,
      env: process.env.NODE_ENV,
      serverTime: new Date().toISOString() 
    });
  });

  /**
   * POST /api/whatsapp/logout
   */
  app.post('/api/whatsapp/logout', async (_req: any, res: any) => {
    try {
      console.log('[WhatsApp] Tentative de déconnexion forcée...');
      
      try {
        await client.logout().catch(() => {});
        await client.destroy().catch(() => {});
      } catch (e) {}
      
      // Tentatives répétées de suppression pour gérer les verrous de fichiers Puppeteer
      let deleted = false;
      for (let i = 0; i < 5; i++) {
        try {
          if (fs.existsSync(AUTH_PATH)) {
            fs.rmSync(AUTH_PATH, { recursive: true, force: true });
          }
          deleted = true;
          break;
        } catch (err) {
          console.warn(`[WhatsApp] Tentative de suppression ${i+1} échouée, nouvel essai dans 500ms...`);
          await new Promise(r => setTimeout(r, 500));
        }
      }

      if (deleted) console.log('[WhatsApp] Dossier de session supprimé.');

      clientStatus = 'initializing';
      qrCodeData = null;
      client = createClient();
      initializeClient();

      res.json({ success: true });
    } catch (err) {
      console.error('[WhatsApp] Erreur critique logout:', err);
      res.status(200).json({ success: false, error: String(err) });
    }
  });

  /**
   * GET /api/whatsapp/contacts
   */
  app.get('/api/whatsapp/contacts', async (_req: any, res: any) => {
    if (clientStatus !== 'connected') {
      return res.status(503).json({ error: 'Client WhatsApp non connecté.' });
    }
    try {
      const contacts = await client.getContacts();
      const personal = (contacts as any[])
        .filter((c: any) => c.isMyContact && !c.isGroup && !c.isBusiness)
        .map((c: any) => ({
          id: c.id._serialized,
          name: c.pushname || c.name || c.id.user,
          number: c.id.user,
        }));
      res.json(personal);
    } catch (err) {
      console.error('[WhatsApp] Erreur getContacts:', err);
      res.status(500).json({ error: 'Impossible de récupérer les contacts.', details: String(err) });
    }
  });

  /**
   * POST /api/whatsapp/check-number
   */
  app.post('/api/whatsapp/check-number', async (req: any, res: any) => {
    if (clientStatus !== 'connected') {
      return res.status(503).json({ error: 'Client WhatsApp non connecté.' });
    }
    const { number } = req.body;
    if (!number) {
      return res.status(400).json({ error: 'Paramètre "number" manquant.' });
    }
    try {
      const numberId = await client.getNumberId(number);
      res.json({ exists: !!numberId, id: numberId ? numberId._serialized : null });
    } catch (err) {
      res.json({ exists: false, id: null });
    }
  });

  /**
   * POST /api/whatsapp/create-group
   */
  app.post('/api/whatsapp/create-group', async (req: any, res: any) => {
    if (clientStatus !== 'connected') {
      return res.status(503).json({ error: 'Client WhatsApp non connecté.' });
    }

    const { groupName, participants } = req.body as { groupName: string; participants: string[] };

    if (!groupName || !Array.isArray(participants) || participants.length === 0) {
      return res.status(400).json({ error: 'Paramètres invalides: groupName et participants sont requis.' });
    }

    try {
      console.log(`[WhatsApp] Création du groupe "${groupName}" avec ${participants.length} participant(s)...`);

      console.log(`[WhatsApp] Vérification de ${participants.length} numéros en parallèle...`);

      const checkNumber = async (num: string) => {
        try {
          const numberId = await client.getNumberId(num);
          return { num, id: numberId ? numberId._serialized : null };
        } catch {
          return { num, id: null };
        }
      };

      // Exécution en parallèle (WhatsApp Web JS gère la file d'attente interne)
      const results = await Promise.all(participants.map(p => checkNumber(p)));
      
      const validParticipants = results.filter(r => r.id).map(r => r.id as string);
      const invalidNumbers = results.filter(r => !r.id).map(r => r.num);

      if (validParticipants.length === 0) {
        return res.status(400).json({
          error: 'Aucun numéro valide trouvé sur WhatsApp.',
          invalidNumbers,
        });
      }

      const result = await client.createGroup(groupName, validParticipants);

      const groupId = typeof result === 'object' && result.gid
        ? result.gid._serialized
        : String(result);

      console.log(`[WhatsApp] Groupe créé avec succès: ${groupId}`);

      res.json({
        success: true,
        groupId,
        groupName,
        addedCount: validParticipants.length,
        invalidNumbers,
      });
    } catch (err) {
      console.error('[WhatsApp] Erreur createGroup:', err);
      res.status(500).json({ error: 'Impossible de créer le groupe.', details: String(err) });
    }
  });

  // ---- Vite Middleware ----
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { 
        middlewareMode: true,
        watch: {
          ignored: ['**/.wwebjs_auth/**']
        }
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve('dist/index.html'));
    });
  }

  app.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`\n🚀 Serveur démarré sur le port ${PORT}`);
    console.log('📱 Gestion de la connexion WhatsApp en cours...\n');
    
    // On lance WhatsApp APRÈS que le serveur Express soit prêt
    initializeClient();
  });

  // Handle clean exit
  const cleanup = async () => {
    console.log('\n[WhatsApp] Fermeture propre...');
    try {
      await client.destroy();
      console.log('[WhatsApp] OK.');
    } catch (e) {
      console.error('[WhatsApp] Erreur lors de la fermeture:', e);
    }
    process.exit(0);
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);
}

startServer();
